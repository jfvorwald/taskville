import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { type EvidenceStore, openEvidenceStore } from "../../src/evidence/index.ts";
import type { ImportJobs } from "../../src/importers/index.ts";
import type { ImportBatch, Importer } from "../../src/importers/types.ts";
import { addProject } from "../ingest/helpers.ts";
import {
  fakeImporter,
  gatedImporter,
  makeJobs,
  PROJECT,
  toolEvent,
  useImportsEnv,
} from "./helpers.ts";

// M8.12 (issue #485): archive retention and the global archive evidence cap.
//
// Options encoded (the implementer must provide them under these names):
//   new ImportJobs({ ..., keepArchives })          done archives kept per (project, kind, root);
//                                                  default 5
//   openEvidenceStore(path, { archiveCapBytes })   cap on archive-scoped evidence bytes across all
//                                                  archives and projects; default 1 GiB
// The jobs runner learns the archive evidence total from the evidence store it is given; these
// tests use a real store and pin only behavior, not the sink's method names.

const env = useImportsEnv();

const MULTI = "multi";

interface Roots {
  r1: string;
  r2: string;
}

/** Project `multi` with two roots, next to the env's `demo` project. */
function addMulti(): Roots {
  const r1 = join(env().dir, "multi-1");
  const r2 = join(env().dir, "multi-2");
  mkdirSync(r1);
  mkdirSync(r2);
  addProject(env().storage, MULTI, [r1, r2]);
  return { r1, r2 };
}

function withStore<T>(capBytes: number | undefined, fn: (store: EvidenceStore) => Promise<T>) {
  const store = openEvidenceStore(join(env().dir, "evidence.db"), {
    ...(capBytes === undefined ? {} : { archiveCapBytes: capBytes }),
  } as Parameters<typeof openEvidenceStore>[1]);
  return fn(store).finally(() => store.close());
}

/** A batch with one tool event for `projectId` and one evidence body of `size` bytes. */
function toolBatch(projectId: string, tag: string, size = 10): ImportBatch {
  const toolCallId = `tc-${tag}`;
  return {
    events: [toolEvent(`e-${tag}`, toolCallId, "2026-11-01T10:00:00Z", { projectId })],
    evidence: [{ toolCallId, output: "a".repeat(size) }],
  };
}

async function runImport(
  jobs: ImportJobs,
  projectId: string,
  kind: "git" | "transcripts",
  root: string,
) {
  const { importId } = jobs.start({ projectId, kind, root });
  const status = await jobs.settled(importId);
  expect(status.status).toBe("done");
  return importId;
}

/** Imports `tags` one after another with the transcripts importer; returns the archive IDs. */
async function importTagged(
  jobsOf: (importer: Importer) => ImportJobs,
  projectId: string,
  root: string,
  tags: readonly string[],
): Promise<string[]> {
  const ids: string[] = [];
  for (const tag of tags) {
    const importer = fakeImporter([toolBatch(projectId, tag)], { kind: "transcripts" });
    ids.push(await runImport(jobsOf(importer), projectId, "transcripts", root));
  }
  return ids;
}

const gone = (id: string) => env().storage.archives().get(id) === undefined;
const eventsOf = (id: string) => env().storage.archives().events(id, 1, 1_000_000).length;

describe("archive retention", () => {
  it("keeps the newest N done archives per project, kind and root, and deletes the rest", async () => {
    const { r1 } = addMulti();
    await withStore(undefined, async (store) => {
      const ids = await importTagged(
        (importer) =>
          makeJobs(env(), [importer], { evidence: store, keepArchives: 2 } as Record<
            string,
            unknown
          >),
        MULTI,
        r1,
        ["a", "b", "c", "d"],
      );
      const [a, b, c, d] = ids as [string, string, string, string];

      expect(gone(a)).toBe(true);
      expect(gone(b)).toBe(true);
      expect(eventsOf(a)).toBe(0);
      expect(eventsOf(b)).toBe(0);
      expect(store.get(MULTI, "tc-a", a)).toBeUndefined();
      expect(store.get(MULTI, "tc-b", b)).toBeUndefined();

      expect(
        env()
          .storage.archives()
          .listDone(MULTI)
          .map((x) => x.id),
      ).toEqual([d, c]);
      expect(eventsOf(c)).toBe(1);
      expect(eventsOf(d)).toBe(1);
      expect(store.get(MULTI, "tc-c", c)?.output?.status).toBe("stored");
      expect(store.get(MULTI, "tc-d", d)?.output?.status).toBe("stored");
    });
  });

  it("keeps the newest 5 by default", async () => {
    const { r1 } = addMulti();
    await withStore(undefined, async (store) => {
      const tags = ["1", "2", "3", "4", "5", "6", "7"];
      const ids = await importTagged(
        (importer) => makeJobs(env(), [importer], { evidence: store }),
        MULTI,
        r1,
        tags,
      );
      expect(ids.slice(0, 2).every(gone)).toBe(true);
      expect(
        env()
          .storage.archives()
          .listDone(MULTI)
          .map((x) => x.id),
      ).toEqual(ids.slice(2).reverse());
      expect(store.get(MULTI, "tc-2", ids[1] as string)).toBeUndefined();
      expect(store.get(MULTI, "tc-3", ids[2] as string)?.output?.status).toBe("stored");
    });
  });

  it("leaves other kinds, roots and projects untouched", async () => {
    const { r1, r2 } = addMulti();
    await withStore(undefined, async (store) => {
      // Built up under a generous limit, so nothing is pruned yet.
      const generous = (importer: Importer) =>
        makeJobs(env(), [importer], { evidence: store, keepArchives: 10 } as Record<
          string,
          unknown
        >);
      const otherRoot = await importTagged(generous, MULTI, r2, ["r2a", "r2b"]);
      const otherProject = await importTagged(generous, PROJECT, env().root, ["pa", "pb"]);
      const otherKind: string[] = [];
      for (const tag of ["ga", "gb"]) {
        const importer = fakeImporter([{ events: [] }], { kind: "git" });
        otherKind.push(await runImport(generous(importer), MULTI, "git", r1));
        void tag;
      }

      const target = await importTagged(
        (importer) =>
          makeJobs(env(), [importer], { evidence: store, keepArchives: 1 } as Record<
            string,
            unknown
          >),
        MULTI,
        r1,
        ["t1", "t2"],
      );

      expect(gone(target[0] as string)).toBe(true);
      expect(gone(target[1] as string)).toBe(false);
      for (const id of [...otherRoot, ...otherProject, ...otherKind]) expect(gone(id)).toBe(false);
      expect(eventsOf(otherRoot[0] as string)).toBe(1);
      expect(eventsOf(otherProject[0] as string)).toBe(1);
      expect(store.get(MULTI, "tc-r2a", otherRoot[0] as string)?.output?.status).toBe("stored");
      expect(store.get(PROJECT, "tc-pa", otherProject[0] as string)?.output?.status).toBe("stored");
    });
  });

  it("never deletes anything when the import fails or is cancelled", async () => {
    const { r1 } = addMulti();
    await withStore(undefined, async (store) => {
      const generous = (importer: Importer) =>
        makeJobs(env(), [importer], { evidence: store, keepArchives: 10 } as Record<
          string,
          unknown
        >);
      const ids = await importTagged(generous, MULTI, r1, ["a", "b", "c"]);
      const strict = (importer: Importer) =>
        makeJobs(env(), [importer], { evidence: store, keepArchives: 1 } as Record<
          string,
          unknown
        >);

      // Failed: the importer throws.
      const failing: Importer = {
        kind: "transcripts",
        // biome-ignore lint/correctness/useYield: it fails before yielding
        async *run() {
          throw new Error("boom");
        },
      };
      const failJobs = strict(failing);
      const failed = failJobs.start({ projectId: MULTI, kind: "transcripts", root: r1 });
      expect((await failJobs.settled(failed.importId)).status).toBe("failed");
      expect(ids.every((id) => !gone(id))).toBe(true);

      // Cancelled: the engine closes mid-import.
      const gate = gatedImporter(toolBatch(MULTI, "x"), "transcripts");
      const cancelJobs = strict(gate.importer);
      const cancelled = cancelJobs.start({ projectId: MULTI, kind: "transcripts", root: r1 });
      await gate.started;
      await cancelJobs.close();
      expect((await cancelJobs.settled(cancelled.importId)).status).toBe("cancelled");
      expect(ids.every((id) => !gone(id))).toBe(true);
      expect(store.get(MULTI, "tc-a", ids[0] as string)?.output?.status).toBe("stored");
    });
  });
});

describe("archive evidence cap", () => {
  const CAP = 100;

  it("drops and counts a new import's evidence once archive evidence has reached the cap", async () => {
    await withStore(CAP, async (store) => {
      // 100 bytes of archive evidence: exactly the cap.
      const first = fakeImporter([toolBatch(PROJECT, "one", CAP)], { kind: "transcripts" });
      const firstId = await runImport(
        makeJobs(env(), [first], { evidence: store }),
        PROJECT,
        "transcripts",
        env().root,
      );
      expect(store.get(PROJECT, "tc-one", firstId)?.output?.status).toBe("stored");
      expect((await makeJobs(env(), []).settled(firstId)).counts.evidenceDropped).toBeUndefined();

      // A second import (even into another project): events import, evidence is dropped.
      const { r1 } = addMulti();
      const second = fakeImporter([toolBatch(MULTI, "two", 10)], { kind: "transcripts" });
      const jobs = makeJobs(env(), [second], { evidence: store });
      const { importId } = jobs.start({ projectId: MULTI, kind: "transcripts", root: r1 });
      const finished = await jobs.settled(importId);

      expect(finished.status).toBe("done");
      expect(finished.counts.imported).toBe(1);
      expect(finished.counts.evidenceDropped).toBe(1);
      expect(eventsOf(importId)).toBe(1);
      expect(store.get(MULTI, "tc-two", importId)).toBeUndefined();
    });
  });

  it("does not limit live evidence", async () => {
    await withStore(CAP, async (store) => {
      const importer = fakeImporter([toolBatch(PROJECT, "one", CAP)], { kind: "transcripts" });
      await runImport(
        makeJobs(env(), [importer], { evidence: store }),
        PROJECT,
        "transcripts",
        env().root,
      );

      store.store(PROJECT, [{ toolCallId: "tc-live", output: "b".repeat(5_000) }]);
      expect(store.get(PROJECT, "tc-live")?.output?.status).toBe("stored");
    });
  });

  it("stores archive evidence below the cap", async () => {
    await withStore(CAP, async (store) => {
      const importer = fakeImporter([toolBatch(PROJECT, "small", 40)], { kind: "transcripts" });
      const id = await runImport(
        makeJobs(env(), [importer], { evidence: store }),
        PROJECT,
        "transcripts",
        env().root,
      );
      expect(store.get(PROJECT, "tc-small", id)?.output?.status).toBe("stored");
    });
  });
});
