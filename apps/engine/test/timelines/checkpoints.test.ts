import { DatabaseSync } from "node:sqlite";
import { sha256Hex, stateHash } from "@taskville/domain/hash";
import {
  initialState,
  type ProjectState,
  REDUCER_VERSION,
  reduce,
} from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { domainReducer } from "../../src/ingest/index.ts";
import type { ProjectionReducer } from "../../src/storage/index.ts";
import { stateAtSequence } from "../../src/timelines/checkpoints.ts";
import { seedLog } from "./day-log.ts";
import { bootInProcess, dayEvents, type Engine, getJson, useDbPath } from "./helpers.ts";

// Replay checkpoints (M6.08, ARCHITECTURE.md 7.4; constitution II and VI). RED phase tests.
//
// Intended interface, in `apps/engine/src/timelines/checkpoints.ts` (the implementer may add more):
//
//   export const CHECKPOINT_INTERVAL = 500;
//   export function stateAtSequence(
//     storage: Storage, projectId: string, upTo: number,
//     options?: { reducer?: ProjectionReducer<ProjectState>; interval?: number },
//   ): ProjectState
//
// - State after events 1..upTo (0 = initial state; upTo is at most the head, callers clamp).
//   `reducer` defaults to `domainReducer`; tests inject others (a different version, a counting
//   apply). `interval` defaults to CHECKPOINT_INTERVAL.
// - Loads the nearest trusted checkpoint at or before `upTo` and applies only the rest; result
//   must equal a full replay (checkpoint equivalence).
// - A checkpoint is trusted only if: its reducer_version equals reducer.version, its sequence is
//   in 1..head, its state_json parses, and stateHash(reducer.version, state) equals state_hash.
//   Anything else is ignored (never thrown on) and rebuilt: after the call, every row for the
//   project is trusted, and rows beyond the head are gone.
// - Write policy (on ingest commit or lazily on first seek) is the implementer's choice, but
//   after stateAtSequence(.., P) returns, a trusted checkpoint exists at every multiple of the
//   interval that is <= P. Rows for other reducer versions are replaced, not accumulated.
//
// Storage (additive migration), table `checkpoints`, STRICT, one row per (project, sequence):
//   project_id TEXT, sequence INTEGER, reducer_version INTEGER, state_hash TEXT, state_json TEXT,
//   PRIMARY KEY (project_id, sequence). state_hash is stateHash(reducer_version, state);
//   state_json is canonicalJson(state). The tests read and corrupt rows with a second raw
//   connection, so these names are part of the contract. The route GET /v1/timelines/:id/state
//   must go through stateAtSequence (read: the result is unchanged, only faster).
//
// The log is the first 2,600 events of the calm demo day (sequence 1 is project.created).

const LOG_LENGTH = 2600;
const events: StoredEnvelope[] = dayEvents().slice(0, LOG_LENGTH);
const PROJECT = events[0]?.projectId ?? "demo";

/** Full replay through `reducer`, never touching checkpoints. */
function fullReplay(reducer: ProjectionReducer<ProjectState>, upTo: number): ProjectState {
  let state = reducer.initial(PROJECT);
  for (const event of events.slice(0, upTo)) state = reducer.apply(state, event);
  return state;
}

/** The domain reducer under another version number, as if its rules had changed. */
function versioned(version: number): ProjectionReducer<ProjectState> {
  return {
    version,
    initial: (projectId) => ({ ...initialState(projectId), reducerVersion: version }),
    apply: (state, event) => ({ ...reduce(state, event), reducerVersion: version }),
  };
}

/** A reducer that counts how many events it was asked to apply. */
function counting(base: ProjectionReducer<ProjectState>) {
  const counter = {
    applied: 0,
    reducer: {
      ...base,
      apply(state: ProjectState, event: StoredEnvelope) {
        counter.applied++;
        return base.apply(state, event);
      },
    } satisfies ProjectionReducer<ProjectState>,
  };
  return counter;
}

interface Row {
  sequence: number;
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
  seedLog(engine.storage, events);
  raw = new DatabaseSync(dbPath());
});
afterEach(() => {
  raw?.close();
  raw = undefined;
  engine?.close();
  engine = undefined;
});

const storage = () => (engine as Engine).storage;
const db = () => raw as DatabaseSync;
const rows = (): Row[] =>
  db()
    .prepare(
      "SELECT sequence, reducer_version, state_hash, state_json FROM checkpoints WHERE project_id = ? ORDER BY sequence",
    )
    .all(PROJECT) as unknown as Row[];
const sequences = () => rows().map((r) => r.sequence);
const multiplesUpTo = (n: number) =>
  Array.from({ length: Math.floor(n / 500) }, (_, i) => (i + 1) * 500);

function expectTrusted(version: number, head: number, reducer = domainReducer) {
  for (const row of rows()) {
    expect(row.reducer_version).toBe(version);
    expect(row.sequence).toBeGreaterThanOrEqual(1);
    expect(row.sequence).toBeLessThanOrEqual(head);
    const state = JSON.parse(row.state_json) as ProjectState;
    expect(row.state_hash).toBe(stateHash(version, state));
    expect(state).toEqual(fullReplay(reducer, row.sequence));
  }
}

describe("checkpoint equivalence", () => {
  it("state at many positions equals a full replay", () => {
    let seed = 7;
    const random = Array.from({ length: 12 }, () => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % (LOG_LENGTH + 1);
    });
    const edges = [
      0,
      1,
      2,
      499,
      500,
      501,
      999,
      1000,
      1001,
      1250,
      1999,
      2000,
      2499,
      2500,
      2501,
      LOG_LENGTH,
    ];
    for (const at of [...edges, ...random]) {
      expect(stateAtSequence(storage(), PROJECT, at)).toEqual(fullReplay(domainReducer, at));
    }
  });

  it("writes a trusted checkpoint at every multiple of 500 up to the position read", () => {
    stateAtSequence(storage(), PROJECT, 1250);
    expect(sequences()).toEqual([500, 1000]);
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
    expect(sequences()).toEqual(multiplesUpTo(LOG_LENGTH));
    expectTrusted(REDUCER_VERSION, LOG_LENGTH);
  });

  it("replays only the events after the nearest checkpoint", () => {
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
    const counter = counting(domainReducer);
    const state = stateAtSequence(storage(), PROJECT, 1250, { reducer: counter.reducer });
    expect(counter.applied).toBeLessThanOrEqual(250);
    expect(state).toEqual(fullReplay(domainReducer, 1250));
  });

  it("a position before the first checkpoint replays from the start", () => {
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
    const counter = counting(domainReducer);
    const state = stateAtSequence(storage(), PROJECT, 300, { reducer: counter.reducer });
    expect(counter.applied).toBe(300);
    expect(state).toEqual(fullReplay(domainReducer, 300));
  });

  it("honors a custom interval", () => {
    stateAtSequence(storage(), PROJECT, 1000, { interval: 200 });
    expect(sequences()).toEqual([200, 400, 600, 800, 1000]);
  });

  it("the state route answers with the same state and writes the checkpoints", async () => {
    for (const at of [1, 499, 500, 1250, 2500, LOG_LENGTH]) {
      const { status, body } = await getJson<{ state: ProjectState; stateHash: string }>(
        app,
        `/v1/timelines/live:${PROJECT}/state?at=${at}`,
      );
      expect(status).toBe(200);
      expect(body.state).toEqual(fullReplay(domainReducer, at));
    }
    expect(sequences()).toEqual(multiplesUpTo(LOG_LENGTH));
  });
});

describe("a reducer version change", () => {
  it("ignores and replaces checkpoints from the old version, and still equals a full replay", () => {
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
    const next = versioned(REDUCER_VERSION + 1);
    const counter = counting(next);
    for (const at of [0, 499, 500, 1250, 2600]) {
      const fresh = at === 1250 ? counter.reducer : next;
      expect(stateAtSequence(storage(), PROJECT, at, { reducer: fresh })).toEqual(
        fullReplay(next, at),
      );
    }
    // The old-version rows were not used for 1250 (a full replay was needed the first time).
    expect(counter.applied).toBeGreaterThanOrEqual(1250 - 500);
    expect(rows().every((r) => r.reducer_version === REDUCER_VERSION + 1)).toBe(true);
    expect(sequences()).toEqual(multiplesUpTo(LOG_LENGTH));
    expectTrusted(REDUCER_VERSION + 1, LOG_LENGTH, next);
  });

  it("old-version checkpoints are not trusted even when their hash is self-consistent", () => {
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
    const next = versioned(REDUCER_VERSION + 1);
    const counter = counting(next);
    stateAtSequence(storage(), PROJECT, 1250, { reducer: counter.reducer });
    expect(counter.applied).toBe(1250);
  });
});

describe("corrupt or stale checkpoints", () => {
  /** Builds checkpoints, corrupts the nearest one for position 1250 (sequence 1000), reads again. */
  function corruptThenRead(corrupt: (row: Row) => void) {
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
    const row = rows().find((r) => r.sequence === 1000) as Row;
    corrupt(row);
    const state = stateAtSequence(storage(), PROJECT, 1250);
    expect(state).toEqual(fullReplay(domainReducer, 1250));
    expect(sequences()).toEqual(multiplesUpTo(LOG_LENGTH));
    expectTrusted(REDUCER_VERSION, LOG_LENGTH);
  }
  const update = (column: string, value: string | number) =>
    db()
      .prepare(`UPDATE checkpoints SET ${column} = ? WHERE project_id = ? AND sequence = 1000`)
      .run(value, PROJECT);

  it("a bad state hash is ignored and rebuilt", () => {
    corruptThenRead(() => update("state_hash", `${REDUCER_VERSION}:${"0".repeat(64)}`));
  });

  it("a state that no longer matches its hash is ignored and rebuilt", () => {
    corruptThenRead((row) => {
      const state = JSON.parse(row.state_json) as ProjectState;
      update("state_json", JSON.stringify({ ...state, head: state.head - 1 }));
    });
  });

  it("bad JSON is ignored and rebuilt", () => {
    corruptThenRead(() => update("state_json", "{not json"));
  });

  it("a row tagged with another reducer version is ignored and rebuilt", () => {
    corruptThenRead(() => update("reducer_version", REDUCER_VERSION - 1));
  });

  it("a checkpoint beyond the end of the log is ignored and removed", async () => {
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
    const good = rows().find((r) => r.sequence === 2500) as Row;
    // Self-consistent in every way but its place: a log that was later cut back, or a forgery.
    db()
      .prepare(
        "INSERT INTO checkpoints (project_id, sequence, reducer_version, state_hash, state_json) VALUES (?, ?, ?, ?, ?)",
      )
      .run(PROJECT, 3000, good.reducer_version, good.state_hash, good.state_json);
    expect(stateAtSequence(storage(), PROJECT, LOG_LENGTH)).toEqual(
      fullReplay(domainReducer, LOG_LENGTH),
    );
    expect(sequences()).toEqual(multiplesUpTo(LOG_LENGTH));
    const { body } = await getJson<{ at: number; state: ProjectState }>(
      app,
      `/v1/timelines/live:${PROJECT}/state?at=999999`,
    );
    expect(body.at).toBe(LOG_LENGTH);
    expect(body.state).toEqual(fullReplay(domainReducer, LOG_LENGTH));
  });

  it("every checkpoint corrupted at once still yields the full replay", () => {
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
    db().prepare("UPDATE checkpoints SET state_json = 'null'").run();
    expect(stateAtSequence(storage(), PROJECT, 2250)).toEqual(fullReplay(domainReducer, 2250));
    expect(sequences()).toEqual(multiplesUpTo(2250));
    expectTrusted(REDUCER_VERSION, 2250);
  });
});

describe("the log keeps growing", () => {
  it("checkpoints made earlier stay valid for later positions", () => {
    stateAtSequence(storage(), PROJECT, 1250);
    const all = dayEvents().slice(0, LOG_LENGTH + 400);
    storage().transaction((tx) => {
      for (const event of all.slice(LOG_LENGTH))
        tx.appendEvent(event, sha256Hex(`hash-${event.ingestSequence}`));
    });
    const full = (() => {
      let state = domainReducer.initial(PROJECT);
      for (const event of all) state = domainReducer.apply(state, event);
      return state;
    })();
    expect(stateAtSequence(storage(), PROJECT, LOG_LENGTH + 400)).toEqual(full);
    expect(sequences()).toEqual(multiplesUpTo(LOG_LENGTH + 400));
  });
});
