import { DatabaseSync } from "node:sqlite";
import { stateHash } from "@taskville/domain/hash";
import {
  type ProjectState,
  projectStateHash,
  REDUCER_VERSION,
  replay,
} from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domainReducer } from "../../src/ingest/index.ts";
import { HASH_A } from "../storage/helpers.ts";
import { CALM } from "./day-log.ts";
import {
  addProject,
  bootInProcess,
  dayEvents,
  type Engine,
  get,
  getJson,
  useDbPath,
} from "./helpers.ts";

// Archive checkpoints (M8.09, #471; ARCHITECTURE.md 7.4; constitution II and VI). RED phase tests.
//
// Measured: a state seek near the end of a 200,000-event archive takes 9 to 12 s and blocks the
// event loop for the whole request. Lead decisions pinned here:
//
// - Table `archive_checkpoints` (STRICT, new migration), one row per (archive_id, position), with
//   columns archive_id, position, reducer_version, state_hash, state_json; state_hash is
//   stateHash(reducer_version, state) and state_json parses to the state after events 1..position.
//   The tests read and corrupt rows with a second raw connection, so these names are the contract.
//   Never the live `checkpoints` table.
// - Interval 1,000 positions. After the first state seek of an archive returns (or shortly after,
//   if the build is deferred; the tests wait up to 2 s), a row exists at every multiple of 1,000
//   up to the archive head. Built by the import or lazily; the test archives are written with
//   `archives().complete`, so the lazy path (the first seek) must build them.
// - A seek reduces at most 999 events once checkpoints exist; it uses the nearest trusted
//   checkpoint at or before the position and replays the rest.
// - A stale reducer_version, unparsable state_json, or state_hash mismatch is ignored (never
//   thrown on); the seek falls back to an earlier trusted checkpoint or full replay.
// - `archives().delete(id)` removes the archive's checkpoints.
// - A replay that has to run yields to the event loop between chunks.
// - Reducer applications are counted by spying on `domainReducer.apply` (the route must keep
//   calling it as a property of that object).

vi.setConfig({ testTimeout: 60_000 });

const ARCHIVE = "11111111-1111-4111-8111-111111111111";
const OTHER = "22222222-2222-4222-8222-222222222222";
const PROJECT = "demo";
const COUNTS = { read: 4500, imported: 4500, skipped: 0, malformed: 0 };
const LENGTH = 4500;
const INTERVAL = 1000;

// Archive events are the calm demo day re-sourced as an import: positions 1..n, mixed kinds.
const SOURCE: StoredEnvelope[] = dayEvents(CALM, PROJECT).slice(0, LENGTH);
const ARCHIVE_EVENTS: StoredEnvelope[] = SOURCE.map((event, index) => ({
  ...event,
  ingestSequence: index + 1,
  provenance: "imported",
}));

/** Full replay of archive events 1..at with the domain reducer, never touching checkpoints. */
function fullReplay(at: number): ProjectState {
  return replay(PROJECT, ARCHIVE_EVENTS.slice(0, at));
}

interface StateBody {
  at: number;
  stateHash: string;
  state: ProjectState;
}

interface Row {
  position: number;
  reducer_version: number;
  state_hash: string;
  state_json: string;
}

const dbPath = useDbPath();
let engine: Engine | undefined;
let app: ReturnType<typeof bootInProcess>["app"];
let raw: DatabaseSync | undefined;

beforeEach(() => {
  const booted = bootInProcess(dbPath());
  engine = booted.engine;
  app = booted.app;
  addProject(engine.storage, PROJECT);
  raw = new DatabaseSync(dbPath());
});
afterEach(() => {
  vi.restoreAllMocks();
  raw?.close();
  raw = undefined;
  engine?.close();
  engine = undefined;
});

const db = () => raw as DatabaseSync;

function makeArchive(id: string, events: StoredEnvelope[] = ARCHIVE_EVENTS): void {
  const archives = (engine as Engine).storage.archives();
  archives.create({
    id,
    projectId: PROJECT,
    kind: "transcripts",
    label: "transcripts: test",
    root: `/tmp/taskville-archive-root-${id}`,
    createdAt: "2026-11-08T09:00:00.000Z",
  });
  archives.complete(id, {
    events: events.map((event) => ({ envelope: event, contentHash: HASH_A })),
    counts: COUNTS,
    finishedAt: "2026-11-08T09:05:00.000Z",
  });
}

const stateUrl = (id: string, at: number) => `/v1/timelines/archive:${id}/state?at=${at}`;
const seek = (at: number, id = ARCHIVE) => getJson<StateBody>(app, stateUrl(id, at));

const rows = (id = ARCHIVE): Row[] =>
  db()
    .prepare(
      "SELECT position, reducer_version, state_hash, state_json FROM archive_checkpoints WHERE archive_id = ? ORDER BY position",
    )
    .all(id) as unknown as Row[];
const positions = (id = ARCHIVE) => rows(id).map((r) => r.position);
const multiples = (n: number) =>
  Array.from({ length: Math.floor(n / INTERVAL) }, (_, i) => (i + 1) * INTERVAL);

/** Seeks the head, which builds the checkpoints, and waits until they are all stored. */
async function build(id = ARCHIVE): Promise<void> {
  const head = (await seek(LENGTH, id)).body;
  expect(head.at).toBe(LENGTH);
  await vi.waitFor(() => expect(positions(id)).toEqual(multiples(LENGTH)), { timeout: 2000 });
}

/** Counts reducer applications made while `run` executes. */
async function applications(run: () => Promise<unknown>): Promise<number> {
  const spy = vi.spyOn(domainReducer, "apply");
  await run();
  const count = spy.mock.calls.length;
  spy.mockRestore();
  return count;
}

describe("archive checkpoint equivalence", () => {
  it("equals a full replay between checkpoints, on one, and at the head", async () => {
    makeArchive(ARCHIVE);
    await build();
    for (const at of [1, 999, 1000, 1001, 2500, 3000, 3999, 4000, LENGTH]) {
      const { status, body } = await seek(at);
      expect(status, `at ${at}`).toBe(200);
      const expected = fullReplay(at);
      expect(body.at).toBe(at);
      expect(body.stateHash, `hash at ${at}`).toBe(projectStateHash(expected));
      expect(body.state, `state at ${at}`).toEqual(expected);
    }
  });

  it("stores checkpoints that are trusted: current version, parsable, hash matches", async () => {
    makeArchive(ARCHIVE);
    await build();
    for (const row of rows()) {
      expect(row.reducer_version).toBe(REDUCER_VERSION);
      const state = JSON.parse(row.state_json) as ProjectState;
      expect(state.head).toBe(row.position);
      expect(row.state_hash).toBe(stateHash(REDUCER_VERSION, state));
      expect(state).toEqual(fullReplay(row.position));
    }
  });
});

describe("archive checkpoints bound the replay", () => {
  it("reduces at most 999 events for a seek near the end", async () => {
    makeArchive(ARCHIVE);
    await build();
    for (const at of [LENGTH - 1, LENGTH, 4000, 3999, 3001]) {
      const applied = await applications(async () => {
        const { body } = await seek(at);
        expect(body.stateHash).toBe(projectStateHash(fullReplay(at)));
      });
      expect(applied, `at ${at}`).toBeLessThanOrEqual(INTERVAL - 1);
    }
  });

  it("reduces nothing for a seek exactly on a checkpoint", async () => {
    makeArchive(ARCHIVE);
    await build();
    const applied = await applications(() => seek(3000));
    expect(applied).toBe(0);
  });
});

describe("archive checkpoint fallback", () => {
  const corruptions: Array<[string, (position: number) => void]> = [
    [
      "a stale reducer version",
      (p) =>
        db()
          .prepare(
            "UPDATE archive_checkpoints SET reducer_version = ? WHERE archive_id = ? AND position = ?",
          )
          .run(REDUCER_VERSION + 100, ARCHIVE, p),
    ],
    [
      "corrupted JSON",
      (p) =>
        db()
          .prepare(
            "UPDATE archive_checkpoints SET state_json = ? WHERE archive_id = ? AND position = ?",
          )
          .run('{"head":', ARCHIVE, p),
    ],
    [
      "a corrupted hash",
      (p) =>
        db()
          .prepare(
            "UPDATE archive_checkpoints SET state_hash = ? WHERE archive_id = ? AND position = ?",
          )
          .run("0".repeat(64), ARCHIVE, p),
    ],
  ];

  it.each(corruptions)(
    "ignores a checkpoint with %s and the result equals a full replay",
    async (_name, corrupt) => {
      makeArchive(ARCHIVE);
      await build();
      corrupt(3000);
      let body: StateBody | undefined;
      // Checkpoint 3000 is bad, so 2000 is the nearest trusted one: at least 1,400 events to reduce.
      const applied = await applications(async () => {
        body = (await seek(3400)).body;
      });
      expect(applied).toBeGreaterThanOrEqual(1400);
      expect(body?.state).toEqual(fullReplay(3400));
      expect(body?.stateHash).toBe(projectStateHash(fullReplay(3400)));
    },
  );

  it.each(corruptions)(
    "falls back to a full replay when every checkpoint has %s",
    async (_name, corrupt) => {
      makeArchive(ARCHIVE);
      await build();
      for (const position of multiples(LENGTH)) corrupt(position);
      const { status, body } = await seek(LENGTH - 5);
      expect(status).toBe(200);
      expect(body.state).toEqual(fullReplay(LENGTH - 5));
      expect(body.stateHash).toBe(projectStateHash(fullReplay(LENGTH - 5)));
    },
  );
});

describe("archive checkpoint pruning", () => {
  it("deletes an archive's checkpoints with it and keeps other archives' rows", async () => {
    makeArchive(ARCHIVE);
    // A second archive of the same events under fresh event ids (event ids are unique per table).
    makeArchive(
      OTHER,
      ARCHIVE_EVENTS.map((event, i) => ({
        ...event,
        eventId: `00000000-0000-4000-9000-${String(i).padStart(12, "0")}`,
      })),
    );
    await build(ARCHIVE);
    await build(OTHER);
    expect(positions(ARCHIVE).length).toBeGreaterThan(0);

    (engine as Engine).storage.archives().delete(ARCHIVE);

    expect(positions(ARCHIVE)).toEqual([]);
    expect(positions(OTHER)).toEqual(multiples(LENGTH));
  });
});

describe("archive replay yields to the event loop", () => {
  it("lets a timer scheduled before the request fire before the response when it has to replay", async () => {
    makeArchive(ARCHIVE);
    // No checkpoints yet: this seek replays 4,500 events (five chunks of 1,000 by default).
    let fired = false;
    setTimeout(() => {
      fired = true;
    }, 0);
    const res = await get(app, stateUrl(ARCHIVE, LENGTH));
    expect(res.status).toBe(200);
    expect(fired).toBe(true);
  });
});

describe("archive checkpoints are isolated from the live checkpoints", () => {
  it("never writes to, and never reads from, the live checkpoints table", async () => {
    // A trusted-looking live checkpoint for the same project at sequence 1000, from other events.
    const liveState = replay(
      PROJECT,
      dayEvents(CALM, PROJECT)
        .slice(0, 5)
        .map((e, i) => ({ ...e, ingestSequence: i + 1 })),
    );
    const poison = { ...liveState, head: INTERVAL };
    db()
      .prepare(
        "INSERT INTO checkpoints (project_id, sequence, reducer_version, state_hash, state_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(
        PROJECT,
        INTERVAL,
        REDUCER_VERSION,
        stateHash(REDUCER_VERSION, poison),
        JSON.stringify(poison),
      );
    const liveBefore = db()
      .prepare("SELECT * FROM checkpoints ORDER BY project_id, sequence")
      .all();
    expect(liveBefore).toHaveLength(1);

    makeArchive(ARCHIVE);
    await build();
    const { body } = await seek(2500);

    expect(body.state).toEqual(fullReplay(2500));
    expect(db().prepare("SELECT * FROM checkpoints ORDER BY project_id, sequence").all()).toEqual(
      liveBefore,
    );
    expect(positions()).toEqual(multiples(LENGTH));
  });

  it("does not write live checkpoints for an archive seek", async () => {
    makeArchive(ARCHIVE);
    await build();
    expect(db().prepare("SELECT count(*) AS n FROM checkpoints").get()).toEqual({ n: 0 });
  });
});

describe("archive checkpoint upkeep (roborev 7753)", () => {
  it("does not write on a seek of a healthy cache, so another writer's lock never blocks it", async () => {
    makeArchive(ARCHIVE);
    await build();
    // Every row is at the current reducer version: nothing to prune, so a seek must not write.
    expect(rows().every((r) => r.reducer_version === REDUCER_VERSION)).toBe(true);

    // The engine's busy timeout is 5,000 ms (storage.ts default). A seek that takes the write
    // lock would wait most of it; a read-only seek returns at once.
    const BUSY_TIMEOUT_MS = 5000;
    const other = new DatabaseSync(dbPath());
    other.exec("PRAGMA busy_timeout = 0");
    other.exec("BEGIN IMMEDIATE");
    try {
      const started = performance.now();
      const { status, body } = await seek(2500);
      const elapsed = performance.now() - started;
      expect(status).toBe(200);
      expect(body.state).toEqual(fullReplay(2500));
      expect(elapsed).toBeLessThan(BUSY_TIMEOUT_MS / 5);
    } finally {
      other.exec("ROLLBACK");
      other.close();
    }
  });

  it("repairs a bad checkpoint followed by a missing one in a single build", async () => {
    makeArchive(ARCHIVE);
    await build();
    db()
      .prepare(
        "UPDATE archive_checkpoints SET state_hash = ? WHERE archive_id = ? AND position = ?",
      )
      .run("0".repeat(64), ARCHIVE, 1000);
    db()
      .prepare("DELETE FROM archive_checkpoints WHERE archive_id = ? AND position = ?")
      .run(ARCHIVE, 2000);

    // One seek, and the build it starts; no further seeks.
    const { body } = await seek(LENGTH);
    expect(body.state).toEqual(fullReplay(LENGTH));

    // Both 1000 and 2000 exist again and hold exactly the state a full replay reaches there.
    await vi.waitFor(
      () => {
        const byPosition = new Map(rows().map((r) => [r.position, r]));
        for (const position of [1000, 2000]) {
          const row = byPosition.get(position);
          expect(row, `checkpoint ${position} exists`).toBeDefined();
          expect(row?.reducer_version).toBe(REDUCER_VERSION);
          expect(JSON.parse(row?.state_json ?? "null")).toEqual(fullReplay(position));
          expect(row?.state_hash).toBe(stateHash(REDUCER_VERSION, fullReplay(position)));
        }
      },
      { timeout: 2000 },
    );
    expect(positions()).toEqual(multiples(LENGTH));
  });
});
