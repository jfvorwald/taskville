import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EvidenceStore, openEvidenceStore } from "../../src/evidence/index.ts";
import type { ImportBatch } from "../../src/importers/types.ts";
import { fakeImporter, makeJobs, PROJECT, toolEvent, useImportsEnv } from "./helpers.ts";

// M8.14 (issue #500): strict archive evidence cap accounting.
//
// (1) each incoming archive body is checked against the remaining budget;
// (2) a pruned archive's bytes are credited only after its evidence is actually deleted;
// (3) when an archive row cannot be deleted after its evidence was, the archive is kept but its
//     evidence reads report "evicted" (as live evidence does), never a silently missing body.

const env = useImportsEnv();

const CAP = 100;
// The store's archive scope key: project, separator, archive ID.
const scope = (projectId: string, archiveId: string) =>
  `${projectId}\u0001archive\u0001${archiveId}`;

function openStore(capBytes: number): EvidenceStore {
  return openEvidenceStore(join(env().dir, "evidence.db"), { archiveCapBytes: capBytes });
}

/** One tool event per body, with the bodies in the given order. */
function batchOf(tag: string, bodies: readonly string[]): ImportBatch {
  return {
    events: bodies.map((_, i) =>
      toolEvent(`e-${tag}-${i}`, `tc-${tag}-${i}`, "2026-11-01T10:00:00Z", { projectId: PROJECT }),
    ),
    evidence: bodies.map((output, i) => ({ toolCallId: `tc-${tag}-${i}`, output })),
  };
}

async function runImport(
  store: unknown,
  tag: string,
  bodies: readonly string[],
  options: Record<string, unknown> = {},
) {
  const importer = fakeImporter([batchOf(tag, bodies)], { kind: "transcripts" });
  const jobs = makeJobs(env(), [importer], { evidence: store, ...options } as Record<
    string,
    unknown
  >);
  const { importId } = jobs.start({
    projectId: PROJECT,
    kind: "transcripts",
    root: env().root,
  });
  const status = await jobs.settled(importId);
  expect(status.status).toBe("done");
  return { id: importId, status };
}

/** Archive evidence bytes held for the given archives. */
const used = (store: EvidenceStore, ids: readonly string[]) =>
  ids.reduce((sum, id) => sum + store.stats(scope(PROJECT, id)).bytes, 0);

describe("strict archive evidence cap", () => {
  it("checks each body against the remaining budget: a 100-byte body is dropped, ones that fit are stored", async () => {
    const store = openStore(CAP);
    try {
      const first = await runImport(store, "first", ["a".repeat(99)]);
      expect(used(store, [first.id])).toBe(99);

      // 1 byte remains. The 100-byte body does not fit; the 1-byte body does; the 2-byte one
      // no longer does. All three are staged ahead of the store, so a whole-import check
      // (99 < 100) would store them all and reach 202 bytes.
      const second = await runImport(store, "second", ["b".repeat(100), "c", "dd"], {
        keepArchives: 10,
      });

      expect(second.status.counts.evidenceDropped).toBe(2);
      expect(store.get(PROJECT, "tc-second-0", second.id)).toBeUndefined();
      expect(store.get(PROJECT, "tc-second-1", second.id)?.output?.status).toBe("stored");
      expect(store.get(PROJECT, "tc-second-2", second.id)).toBeUndefined();
      expect(used(store, [first.id, second.id])).toBeLessThanOrEqual(CAP);
    } finally {
      store.close();
    }
  });
});

describe("credit only after the evidence is deleted", () => {
  it("drops the new import's evidence when the pruned archive's evidence cannot be deleted", async () => {
    const store = openStore(CAP);
    try {
      // Every deleteArchive fails; everything else is the real store.
      const sink = new Proxy(store, {
        get(target, prop) {
          if (prop === "deleteArchive") {
            return () => {
              throw new Error("evidence delete failed");
            };
          }
          const value = Reflect.get(target, prop, target);
          return typeof value === "function" ? value.bind(target) : value;
        },
      });
      const options = { keepArchives: 1 };

      const first = await runImport(sink, "first", ["a".repeat(60)], options);
      expect(used(store, [first.id])).toBe(60);

      // Retention would prune `first` to make room, but its evidence stays: no room is credited.
      const second = await runImport(sink, "second", ["b".repeat(60)], options);

      expect(second.status.counts.evidenceDropped).toBe(1);
      expect(store.get(PROJECT, "tc-second-0", second.id)).toBeUndefined();
      expect(store.get(PROJECT, "tc-first-0", first.id)?.output?.status).toBe("stored");
      expect(used(store, [first.id, second.id])).toBeLessThanOrEqual(CAP);
    } finally {
      store.close();
    }
  });
});

describe("archive row deletion fails after its evidence was deleted", () => {
  it("keeps the archive and reports its evidence as evicted, not missing", async () => {
    const store = openStore(1_000_000);
    try {
      // Every archive row deletion fails; everything else is real.
      const failingStorage = new Proxy(env().storage, {
        get(target, prop) {
          const value = Reflect.get(target, prop, target);
          if (prop !== "archives" || typeof value !== "function") {
            return typeof value === "function" ? value.bind(target) : value;
          }
          return () => {
            const archives = value.call(target);
            return new Proxy(archives, {
              get(inner, innerProp) {
                if (innerProp === "delete") {
                  return () => {
                    throw new Error("row delete failed");
                  };
                }
                const member = Reflect.get(inner, innerProp, inner);
                return typeof member === "function" ? member.bind(inner) : member;
              },
            });
          };
        },
      });

      const run = async (tag: string) => {
        const importer = fakeImporter([batchOf(tag, ["x".repeat(10)])], { kind: "transcripts" });
        const jobs = makeJobs(env(), [importer], {
          evidence: store,
          keepArchives: 1,
          storage: failingStorage,
        } as Record<string, unknown>);
        const { importId } = jobs.start({
          projectId: PROJECT,
          kind: "transcripts",
          root: env().root,
        });
        expect((await jobs.settled(importId)).status).toBe("done");
        return importId;
      };

      const a = await run("a");
      const b = await run("b");

      // The row of `a` survived the failed deletion and is still a visible done archive...
      expect(env().storage.archives().get(a)?.status).toBe("done");
      // ...so its bodies must read as evicted ("details no longer stored"), never as missing.
      const evicted = store.get(PROJECT, "tc-a-0", a)?.output;
      expect(evicted?.status).toBe("evicted");
      expect(used(store, [a])).toBe(0);
      // The newest archive is untouched.
      expect(store.get(PROJECT, "tc-b-0", b)?.output?.status).toBe("stored");
    } finally {
      store.close();
    }
  });
});
