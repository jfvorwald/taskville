import { DatabaseSync } from "node:sqlite";
import { stateHash } from "@taskville/domain/hash";
import { type ProjectState, REDUCER_VERSION } from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domainReducer } from "../../src/ingest/index.ts";
import {
  type CheckpointRow,
  type ProjectionReducer,
  rebuildStaleProjections,
} from "../../src/storage/index.ts";
import { type StateAtOptions, stateAtSequence } from "../../src/timelines/checkpoints.ts";
import { dayEvents, LIVELY, seedLog } from "./day-log.ts";
import { bootInProcess, type Engine, useDbPath } from "./helpers.ts";

// M6.12 (#347): checkpoint cache hardening from the M6.11 reviews. RED phase tests.
//
// Intended behavior for the implementer (lead decisions included):
// - Seek path (attempt() in timelines/checkpoints.ts): catch silently only busy errors (SQLite
//   errcode 5 or 6, "database is locked/busy") and "wait budget spent" errors. Any other error
//   from cache upkeep (prune, delete, put) is logged ONCE at warn or error level, with no state
//   JSON or event bodies in the log call, and the seek still answers the right state.
//   Interface assumed by these tests: `StateAtOptions.logger` (a pino-style logger; only
//   warn/error are used here, any level counts as "logged").
// - Boot backfill (rebuildStaleProjections): a non-busy cache write failure (SQLITE_FULL,
//   SQLITE_READONLY) does not abort boot; it logs one line, bodies excluded, and boot goes on.
//   Interface assumed: a third argument `{ logger }`. (The M6.11 pin "rethrows an error that is
//   not a busy lock" in checkpoints-followups.test.ts is replaced by this decision.)
// - Writes are batched: no more than 20 rows per put (so per transaction), on the seek path and in
//   the boot backfill, so state JSON is not all held in memory until one put.
// - Boot backfill validates rows at multiples of the interval with the same trust check as a seek
//   (version, parse, head/project binding, hash) and rewrites a wrong-version or corrupt row.
//
// Each describe says whether it already passes on main (pin) or fails.

const LOG_LENGTH = 2600;
const events: StoredEnvelope[] = dayEvents().slice(0, LOG_LENGTH);
const PROJECT = events[0]?.projectId ?? "demo";
const MAX_BATCH = 20;

function fullReplay(upTo: number, from: readonly StoredEnvelope[] = events): ProjectState {
  let state = domainReducer.initial(PROJECT);
  for (const event of from.slice(0, upTo)) state = domainReducer.apply(state, event);
  return state;
}

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

/** A recording logger; every level counts, so the tests do not pin warn versus error. */
function recordingLogger() {
  const fns = {
    trace: vi.fn(),
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
  };
  return {
    ...fns,
    calls: () => Object.values(fns).flatMap((fn) => fn.mock.calls),
  };
}

/** No state JSON, event bodies or row text in what was logged. */
function expectNoBodies(calls: unknown[][]) {
  const text = JSON.stringify(calls, (_key, value) =>
    value instanceof Error ? { name: value.name, message: value.message } : value,
  );
  for (const marker of ['"head"', '"reducerVersion"', '"stateJson"', '"projectId"', "state_json"]) {
    expect(text).not.toContain(marker);
  }
}

const dbError = (message: string, errcode: number) =>
  Object.assign(new Error(message), { errcode });
const FULL = () => dbError("database or disk is full", 13);
const READONLY = () => dbError("attempt to write a readonly database", 8);

const dbPath = useDbPath();
let engine: Engine | undefined;
let raw: DatabaseSync | undefined;

beforeEach(() => {
  engine = bootInProcess(dbPath()).engine;
  raw = new DatabaseSync(dbPath());
});
afterEach(() => {
  raw?.close();
  raw = undefined;
  engine?.close();
  engine = undefined;
  vi.restoreAllMocks();
});

const storage = () => (engine as Engine).storage;
const db = () => raw as DatabaseSync;
const sequencesOf = (project: string): number[] =>
  (
    db()
      .prepare("SELECT sequence FROM checkpoints WHERE project_id = ? ORDER BY sequence")
      .all(project) as unknown as { sequence: number }[]
  ).map((r) => r.sequence);

// Boot is given the logger as a third argument; typed loosely until the implementation adds it.
const bootRebuild = rebuildStaleProjections as unknown as (
  storage: unknown,
  reducer: unknown,
  options?: { logger: unknown },
) => string[];

describe("seek path: attempt() catches only busy and budget-spent errors", () => {
  beforeEach(() => seedLog(storage(), events));

  /** A seek over an empty cache, so there is a put to fail, with the logger passed in. */
  function seekWithFailingPut(error: Error) {
    db().exec("DELETE FROM checkpoints");
    const logger = recordingLogger();
    const options: StateAtOptions & { logger: typeof logger } = { logger };
    const put = vi.spyOn(storage().checkpoints(), "put").mockImplementation(() => {
      throw error;
    });
    const state = stateAtSequence(storage(), PROJECT, 1250, options);
    return { logger, put, state };
  }

  // Pins (pass on main: everything is swallowed silently).
  it.each([
    ["SQLITE_BUSY (errcode 5)", dbError("database is busy", 5)],
    ["SQLITE_LOCKED (errcode 6)", dbError("database table is locked", 6)],
    ["a message-only lock error", new Error("database is locked")],
    ["a spent upkeep budget", new Error("checkpoint upkeep skipped: wait budget spent")],
  ])("%s stays silent and the seek answers the right state", (_name, error) => {
    const { logger, put, state } = seekWithFailingPut(error);
    expect(put).toHaveBeenCalled();
    expect(logger.calls()).toEqual([]);
    expect(state).toEqual(fullReplay(1250));
  });

  // FAIL on main: attempt() swallows the error and never logs it.
  it.each([
    ["SQLITE_FULL", FULL()],
    ["SQLITE_READONLY", READONLY()],
    ["an unknown error", new Error("disk exploded")],
  ])(
    "%s on the cache write is logged once, without bodies, and the seek still answers",
    (_name, error) => {
      const { logger, put, state } = seekWithFailingPut(error);
      expect(put).toHaveBeenCalled();
      expect(state).toEqual(fullReplay(1250));
      expect(logger.calls()).toHaveLength(1);
      expectNoBodies(logger.calls());
    },
  );

  // FAIL on main, same reason, for the other upkeep steps (prune and delete of a bad row).
  it("a non-busy error from prune is logged once and the seek still answers", () => {
    const logger = recordingLogger();
    const options: StateAtOptions & { logger: typeof logger } = { logger };
    const prune = vi.spyOn(storage().checkpoints(), "prune").mockImplementation(() => {
      throw FULL();
    });
    const state = stateAtSequence(storage(), PROJECT, 1250, options);
    expect(prune).toHaveBeenCalled();
    expect(state).toEqual(fullReplay(1250));
    expect(logger.calls()).toHaveLength(1);
    expectNoBodies(logger.calls());
  });

  it("a non-busy error from deleting a corrupt row is logged and the seek still answers", () => {
    stateAtSequence(storage(), PROJECT, LOG_LENGTH); // populate
    db().prepare("UPDATE checkpoints SET state_hash = 'bad' WHERE sequence = 1000").run();
    const logger = recordingLogger();
    const options: StateAtOptions & { logger: typeof logger } = { logger };
    vi.spyOn(storage().checkpoints(), "delete").mockImplementation(() => {
      throw FULL();
    });
    const state = stateAtSequence(storage(), PROJECT, 1250, options);
    expect(state).toEqual(fullReplay(1250));
    expect(logger.calls().length).toBeGreaterThanOrEqual(1);
    expectNoBodies(logger.calls());
  });
});

describe("cache writes are batched", () => {
  const rowsPerPut = (spy: { mock: { calls: unknown[][] } }): number[] =>
    spy.mock.calls.map((call) => (call[1] as CheckpointRow[]).length);

  // FAILS on main: all 52 fresh rows go to one put (one transaction, all JSON held in memory).
  it("a cold seek writes at most 20 rows per put", () => {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    const put = vi.spyOn(storage().checkpoints(), "put");
    const state = stateAtSequence(storage(), PROJECT, LOG_LENGTH, { interval: 50 });
    expect(state).toEqual(fullReplay(LOG_LENGTH));
    const sizes = rowsPerPut(put);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(52);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_BATCH);
    expect(sequencesOf(PROJECT)).toHaveLength(52);
  }, 30_000);

  // FAILS on main: the backfill makes one put of every missing row. LIVELY is 50,005 events, so
  // 100 checkpoints, enough to need several batches.
  it("boot backfill writes at most 20 rows per put, and still writes them all", () => {
    const lively = dayEvents(LIVELY);
    seedLog(storage(), lively);
    db().exec("DELETE FROM checkpoints");
    const put = vi.spyOn(storage().checkpoints(), "put");
    expect(rebuildStaleProjections(storage(), domainReducer)).toEqual([]); // fresh, so backfill only
    const sizes = rowsPerPut(put);
    expect(Math.max(...sizes)).toBeLessThanOrEqual(MAX_BATCH);
    expect(sizes.reduce((a, b) => a + b, 0)).toBe(Math.floor(lively.length / 500));
    expect(sequencesOf(PROJECT)).toHaveLength(Math.floor(lively.length / 500));
  }, 120_000);
});

describe("boot backfill treats an untrustworthy row at a multiple of 500 as missing", () => {
  const rowAt = (sequence: number) =>
    db()
      .prepare(
        "SELECT reducer_version, state_hash, state_json FROM checkpoints WHERE project_id = ? AND sequence = ?",
      )
      .get(PROJECT, sequence) as unknown as {
      reducer_version: number;
      state_hash: string;
      state_json: string;
    };

  const damage: [string, (sequence: number) => void][] = [
    [
      "a wrong reducer version",
      (s) =>
        void db()
          .prepare("UPDATE checkpoints SET reducer_version = ? WHERE sequence = ?")
          .run(REDUCER_VERSION - 1, s),
    ],
    [
      "unparseable state text",
      (s) =>
        void db().prepare("UPDATE checkpoints SET state_json = '{oops' WHERE sequence = ?").run(s),
    ],
    [
      "a hash that does not match the state",
      (s) =>
        void db().prepare("UPDATE checkpoints SET state_hash = 'bad' WHERE sequence = ?").run(s),
    ],
    [
      "a state that belongs to another head",
      (s) => {
        const wrong = fullReplay(500);
        db()
          .prepare("UPDATE checkpoints SET state_json = ?, state_hash = ? WHERE sequence = ?")
          .run(JSON.stringify(wrong), stateHash(REDUCER_VERSION, wrong), s);
      },
    ],
  ];

  // FAIL on main: backfill counts any stored sequence as present and leaves the bad row alone.
  it.each(damage)(
    "%s at 1000 is replaced at boot, so the first seek reads a trusted row",
    (_name, hurt) => {
      seedLog(storage(), events);
      rebuildStaleProjections(storage(), domainReducer); // fresh projection; backfill writes the cache
      expect(sequencesOf(PROJECT)).toEqual([500, 1000, 1500, 2000, 2500]);
      hurt(1000);

      expect(rebuildStaleProjections(storage(), domainReducer)).toEqual([]); // not a rebuild

      const row = rowAt(1000);
      expect(row.reducer_version).toBe(REDUCER_VERSION);
      expect(JSON.parse(row.state_json)).toEqual(fullReplay(1000));
      expect(row.state_hash).toBe(stateHash(REDUCER_VERSION, fullReplay(1000)));

      const counter = counting(domainReducer);
      const state = stateAtSequence(storage(), PROJECT, 1250, { reducer: counter.reducer });
      expect(state).toEqual(fullReplay(1250));
      expect(counter.applied).toBeLessThanOrEqual(250);
    },
  );

  // Pin (passes on main): a healthy complete cache is left alone.
  it("a complete healthy cache is not rewritten", () => {
    seedLog(storage(), events);
    rebuildStaleProjections(storage(), domainReducer);
    const put = vi.spyOn(storage().checkpoints(), "put");
    rebuildStaleProjections(storage(), domainReducer);
    expect(put).not.toHaveBeenCalled();
  });
});

describe("a non-busy cache write failure during boot backfill does not abort boot", () => {
  function freshProjectionNoCheckpoints() {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    expect(sequencesOf(PROJECT)).toEqual([]);
  }

  // FAIL on main: the error propagates out of rebuildStaleProjections (boot aborts).
  it.each([
    ["SQLITE_FULL", FULL],
    ["SQLITE_READONLY", READONLY],
  ])("%s: no throw, the projection is kept, one log line without bodies", (_name, make) => {
    freshProjectionNoCheckpoints();
    const before = storage().projection(PROJECT);
    const logger = recordingLogger();
    const put = vi.spyOn(storage().checkpoints(), "put").mockImplementation(() => {
      throw make();
    });
    let rebuilt: string[] | undefined;
    expect(() => {
      rebuilt = bootRebuild(storage(), domainReducer, { logger });
    }).not.toThrow();
    expect(put).toHaveBeenCalled();
    expect(rebuilt).toEqual([]);
    expect(storage().projection(PROJECT)).toEqual(before);
    expect(logger.calls()).toHaveLength(1);
    expectNoBodies(logger.calls());
  });

  // Pin (passes on main): the cache stays disposable, a later seek still answers and fills it.
  it("a seek after the failed backfill answers the right state and fills the cache", () => {
    freshProjectionNoCheckpoints();
    expect(stateAtSequence(storage(), PROJECT, 1250)).toEqual(fullReplay(1250));
    expect(sequencesOf(PROJECT)).toEqual([500, 1000]);
  });

  // Pin (passes on main): a busy lock is silent at boot too (M6.11 behavior stays).
  it("a busy error is not logged", () => {
    freshProjectionNoCheckpoints();
    const logger = recordingLogger();
    vi.spyOn(storage().checkpoints(), "put").mockImplementation(() => {
      throw dbError("database is locked", 5);
    });
    expect(() => bootRebuild(storage(), domainReducer, { logger })).not.toThrow();
    expect(logger.calls()).toEqual([]);
  });
});
