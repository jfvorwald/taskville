import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { projectStateHash, replay } from "@taskville/domain/reducer";
import type { InputEventWire } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { type ImportJobs, registerImportRoutes } from "../../src/importers/index.ts";
import { bearer, CLI_TOKEN } from "../http/helpers.ts";
import { addProject, BASE, bootInProcess, type Engine } from "../stream/helpers.ts";
import { commitEvent, fakeImporter, type ImportsEnv, makeJobs, PROJECT } from "./helpers.ts";

// Archive checkpoints are built right after an import completes the archive (M8.19, #531; builds
// on M8.09's archive_checkpoints, ARCHITECTURE.md 7.4). RED phase tests.
//
// Today ArchiveStates (src/timelines/archive-state.ts) builds checkpoints lazily after the first
// state seek, so the first seek of a fresh 200,000-event archive takes about 6.7 s. Pinned:
//
// 1. Completing an import writes `archive_checkpoints` rows at every multiple of 1,000 up to the
//    head with no state seek. The build may be deferred and yields, so the tests wait up to 5 s.
// 2. The job reports `done` (ImportJobs.settled and GET /v1/imports/:id) without waiting for the
//    build: when the job is done the rows are not all there yet (ordering, not wall time).
// 3. A seek that arrives while the post-import build runs shares it. Seam: the number of
//    `putCheckpoint` calls on the archives store per position (one build writes each once; two
//    builds would write some twice), plus final rows equal to a full replay.
// 4. An archive pruned (a newer import beyond keepArchives) while its build runs: nothing
//    crashes, nothing is logged as a failure, and no rows are left for it.
//
// The importer is the in-memory fake from helpers.ts; storage is real SQLite in a temp dir; rows
// are read with a second raw node:sqlite connection. The tests never seek before the rows exist,
// except test 3, which seeks only after the build has started.

vi.setConfig({ testTimeout: 30_000 });

const INTERVAL = 1000;
const LENGTH = 3500;
const WAIT = { timeout: 5000, interval: 5 };
const T_START = Date.parse("2026-11-01T10:00:00Z");

let dir = "";
let root = "";
let engine: Engine;
let app: ReturnType<typeof bootInProcess>["app"];
let raw: DatabaseSync;
let jobs: ImportJobs | undefined;
const warn = vi.fn();

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "taskville-m819-")));
  root = join(dir, "repo");
  mkdirSync(root);
  const booted = bootInProcess(join(dir, "taskville.db"));
  engine = booted.engine;
  app = booted.app;
  addProject(engine.storage, PROJECT, [root]);
  raw = new DatabaseSync(join(dir, "taskville.db"));
  warn.mockClear();
});

afterEach(async () => {
  vi.restoreAllMocks();
  await jobs?.close();
  jobs = undefined;
  raw.close();
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

/** `LENGTH` valid git.commit events, one second apart, in a fresh namespace per `tag`. */
function events(tag: string, n = LENGTH): InputEventWire[] {
  return Array.from({ length: n }, (_, i) =>
    commitEvent(`${tag}-${i}`, new Date(T_START + i * 1000).toISOString()),
  );
}

function batches(list: InputEventWire[]) {
  const out = [];
  for (let i = 0; i < list.length; i += 500) out.push({ events: list.slice(i, i + 500) });
  return out;
}

function setup(keepArchives?: number): ImportJobs {
  const env: ImportsEnv = { dir, root, storage: engine.storage, dbPath: join(dir, "taskville.db") };
  const importers = [
    // One importer; each start() reads whatever `next` holds.
    {
      kind: "git" as const,
      run: (context: Parameters<ReturnType<typeof fakeImporter>["run"]>[0]) =>
        fakeImporter(batches(next)).run(context),
    },
  ];
  jobs = makeJobs(env, importers, {
    logger: { warn, info: vi.fn(), error: vi.fn(), debug: vi.fn() } as never,
    ...(keepArchives === undefined ? {} : { keepArchives }),
  });
  registerImportRoutes(app, jobs);
  return jobs;
}
let next: InputEventWire[] = [];

const start = (j: ImportJobs, list: InputEventWire[]) => {
  next = list;
  return j.start({ projectId: PROJECT, kind: "git", root });
};

const positions = (id: string): number[] =>
  (
    raw
      .prepare("SELECT position FROM archive_checkpoints WHERE archive_id = ? ORDER BY position")
      .all(id) as Array<{ position: number }>
  ).map((r) => r.position);
const multiples = (n: number) =>
  Array.from({ length: Math.floor(n / INTERVAL) }, (_, i) => (i + 1) * INTERVAL);
const headRows = (id: string) =>
  raw
    .prepare("SELECT position, state_hash FROM archive_checkpoints WHERE archive_id = ?")
    .all(id) as Array<{ position: number; state_hash: string }>;

describe("archive checkpoints after an import", () => {
  it("writes a checkpoint at every multiple of 1,000 up to the head without any seek", async () => {
    const j = setup();
    const { archiveId, importId } = start(j, events("a"));
    const done = await j.settled(importId);
    expect(done.status).toBe("done");
    expect(done.counts.imported).toBe(LENGTH);

    await vi.waitFor(() => expect(positions(archiveId)).toEqual(multiples(LENGTH)), WAIT);
  });

  it("reports done before the build finishes (job completion does not wait for it)", async () => {
    const j = setup();
    const { archiveId, importId } = start(j, events("b"));
    const done = await j.settled(importId);
    expect(done.status).toBe("done");

    // Ordering: at the moment the job is done and the status route has answered, the build has
    // not finished (it yields between 1,000-event chunks), yet the job is already done.
    const res = await app.request(`${BASE}/v1/imports/${importId}`, { headers: bearer(CLI_TOKEN) });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { status: string }).status).toBe("done");
    expect(positions(archiveId).length).toBeLessThan(multiples(LENGTH).length);

    // ... and the build does happen, with no seek.
    await vi.waitFor(() => expect(positions(archiveId)).toEqual(multiples(LENGTH)), WAIT);
  });

  it("shares the running build with a seek: each position is written once and rows are correct", async () => {
    const j = setup();
    const list = events("c");
    const put = vi.spyOn(engine.storage.archives(), "putCheckpoint");
    const { archiveId, importId } = start(j, list);
    await j.settled(importId);

    // The post-import build has started (first row written) with no seek issued yet.
    await vi.waitFor(() => expect(positions(archiveId).length).toBeGreaterThan(0), WAIT);

    const res = await app.request(`${BASE}/v1/timelines/archive:${archiveId}/state?at=${LENGTH}`, {
      headers: bearer(CLI_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { stateHash: string };
    const stored = engine.storage.archives().events(archiveId, 1, LENGTH);
    expect(body.stateHash).toBe(projectStateHash(replay(PROJECT, stored)));

    await vi.waitFor(() => expect(positions(archiveId)).toEqual(multiples(LENGTH)), WAIT);
    const written = put.mock.calls
      .filter(([id]) => id === archiveId)
      .map(([, row]) => row.sequence);
    expect(written.slice().sort((a, b) => a - b)).toEqual(multiples(LENGTH));
    for (const row of headRows(archiveId)) {
      const state = replay(PROJECT, stored.slice(0, row.position));
      expect(row.state_hash, `hash at ${row.position}`).toBeTruthy();
      expect(JSON.parse(readJson(archiveId, row.position)).head).toBe(state.head);
    }
  });

  it("survives its archive being pruned mid-build and leaves no rows for it", async () => {
    const j = setup(1);
    const first = start(j, events("d1"));
    await j.settled(first.importId);
    // The first archive's build is under way (a row exists), with no seek.
    await vi.waitFor(() => expect(positions(first.archiveId).length).toBeGreaterThan(0), WAIT);

    // A newer import of the same kind and root prunes it (keepArchives is 1).
    const second = start(j, events("d2", 2200));
    const finished = await j.settled(second.importId);
    expect(finished.status).toBe("done");
    expect(engine.storage.archives().get(first.archiveId)).toBeUndefined();

    // Give the old build time to hit the missing archive; then nothing is left for it.
    await vi.waitFor(() => expect(positions(second.archiveId)).toEqual(multiples(2200)), WAIT);
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(positions(first.archiveId)).toEqual([]);
    expect(warn).not.toHaveBeenCalledWith(expect.anything(), "archive checkpoint build failed");
  });
});

function readJson(id: string, position: number): string {
  const row = raw
    .prepare("SELECT state_json FROM archive_checkpoints WHERE archive_id = ? AND position = ?")
    .get(id, position) as { state_json: string };
  return row.state_json;
}
