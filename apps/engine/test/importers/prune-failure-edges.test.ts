import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EvidenceStore, openEvidenceStore } from "../../src/evidence/index.ts";
import type { ImportBatch } from "../../src/importers/types.ts";
import { fakeImporter, makeJobs, PROJECT, toolEvent, useImportsEnv } from "./helpers.ts";

// M8.17 (issue #517): failure-of-failure edges in archive pruning and counting.
//
// (1) updateCounts fails after bodies were dropped for the cap: the done archive must never
//     carry counts that silently omit the drops.
// (2) the final pointer deletion fails after the pruned row is gone: no pointers stay orphaned
//     once things recover.

const env = useImportsEnv();

function openStore(capBytes: number): EvidenceStore {
  return openEvidenceStore(join(env().dir, "evidence.db"), { archiveCapBytes: capBytes });
}

function batchOf(tag: string, bodies: readonly string[]): ImportBatch {
  return {
    events: bodies.map((_, i) =>
      toolEvent(`e-${tag}-${i}`, `tc-${tag}-${i}`, "2026-11-01T10:00:00Z", { projectId: PROJECT }),
    ),
    evidence: bodies.map((output, i) => ({ toolCallId: `tc-${tag}-${i}`, output })),
  };
}

/** Wraps an object so that listed members are replaced and functions stay bound. */
function wrap<T extends object>(target: T, overrides: Record<string, unknown>): T {
  return new Proxy(target, {
    get(inner, prop) {
      if (typeof prop === "string" && prop in overrides) return overrides[prop];
      const value = Reflect.get(inner, prop, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });
}

async function runImport(tag: string, bodies: readonly string[], options: Record<string, unknown>) {
  const importer = fakeImporter([batchOf(tag, bodies)], { kind: "transcripts" });
  const jobs = makeJobs(env(), [importer], options);
  const { importId } = jobs.start({ projectId: PROJECT, kind: "transcripts", root: env().root });
  const status = await jobs.settled(importId);
  expect(status.status).toBe("done");
  return importId;
}

describe("updateCounts fails after bodies were dropped for the cap", () => {
  it("never leaves a done archive whose counts omit the missing bodies", async () => {
    const store = openStore(100);
    try {
      const failingStorage = wrap(env().storage, {
        archives: () =>
          wrap(env().storage.archives(), {
            updateCounts: () => {
              throw new Error("updateCounts failed");
            },
          }),
      });
      // The first body does not fit the 100-byte cap and is dropped; the second would fit.
      const bodies = ["a".repeat(150), "b"];
      const id = await runImport("t", bodies, {
        evidence: store,
        keepArchives: 5,
        storage: failingStorage,
      });

      const archive = env().storage.archives().get(id);
      expect(archive?.status).toBe("done");
      const stored = bodies.filter(
        (_, i) => store.get(PROJECT, `tc-t-${i}`, id)?.output?.status === "stored",
      ).length;
      const missing = bodies.length - stored;
      expect(missing).toBeGreaterThan(0);

      // Either the counts account for every missing body (atomic outcome), or the archive says
      // explicitly that its counts are incomplete (`countsIncomplete: true`).
      const counts = archive?.counts as unknown as {
        evidenceDropped?: number;
        countsIncomplete?: boolean;
      };
      const accountedFor = (counts.evidenceDropped ?? 0) >= missing;
      expect(accountedFor || counts.countsIncomplete === true).toBe(true);
    } finally {
      store.close();
    }
  });
});

describe("final pointer deletion fails after the pruned archive row is deleted", () => {
  it("leaves no orphaned pointers once a later import runs", async () => {
    const store = openStore(1_000_000);
    try {
      // Only the pointer-removing deleteArchive (no keepPointers) fails, and only while `broken`.
      let broken = true;
      const sink = wrap(store, {
        deleteArchive: (projectId: string, archiveId: string, o?: { keepPointers?: boolean }) => {
          if (broken && o?.keepPointers !== true) throw new Error("pointer delete failed");
          store.deleteArchive(projectId, archiveId, o);
        },
      });
      const options = { evidence: sink, keepArchives: 1 };

      const a = await runImport("a", ["x".repeat(10)], options);
      await runImport("b", ["y".repeat(10)], options);

      // The row of `a` was pruned, so its pointers must not linger as phantom "evicted" bodies
      // (they may only exist transiently, awaiting a retried cleanup).
      expect(env().storage.archives().get(a)).toBeUndefined();

      // Things recover: the store works again, and the next import runs.
      broken = false;
      await runImport("c", ["z".repeat(10)], options);

      expect(env().storage.archives().get(a)).toBeUndefined();
      expect(store.get(PROJECT, "tc-a-0", a)).toBeUndefined();
    } finally {
      store.close();
    }
  });
});
