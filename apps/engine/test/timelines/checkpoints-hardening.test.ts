import { DatabaseSync } from "node:sqlite";
import { canonicalJson, stateHash } from "@taskville/domain/hash";
import { type ProjectState, REDUCER_VERSION } from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domainReducer } from "../../src/ingest/index.ts";
import { SqliteCheckpoints, trusted } from "../../src/storage/checkpoints.ts";
import {
  type CheckpointRow,
  type ProjectionReducer,
  rebuildStaleProjections,
} from "../../src/storage/index.ts";
import { type StateAtOptions, stateAtSequence } from "../../src/timelines/checkpoints.ts";
import { CALM, dayEvents, LIVELY, seedLog } from "./day-log.ts";
import { bootInProcess, type Engine, getJson, useDbPath } from "./helpers.ts";

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

/** Every string reachable from `value`: nested objects, arrays, and Error name, message and stack. */
function stringsIn(value: unknown, seen = new Set<unknown>()): string[] {
  if (typeof value === "string") return [value];
  if (value === null || typeof value !== "object" || seen.has(value)) return [];
  seen.add(value);
  const own = value instanceof Error ? [value.name, value.message, value.stack ?? ""] : [];
  return [...own, ...Object.values(value).flatMap((v) => stringsIn(v, seen))];
}

/** A distinctive slice of a real state body, so a state JSON passed as a string is recognised. */
const STATE_MARKER = canonicalJson(fullReplay(500)).slice(0, 60);

/** No state JSON, event bodies or row text in what was logged, inspecting every string directly. */
function expectNoBodies(calls: unknown[][]) {
  for (const text of stringsIn(calls)) {
    expect(text).not.toContain(STATE_MARKER);
    expect(text.trimStart().startsWith("{")).toBe(false);
    expect(text.length).toBeLessThan(200);
  }
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

// ---- Red round 2 (PR #357 code review and roborev panel 6769) ----

/** warn and error calls only (boot also logs info lines of its own). */
const problems = (logger: ReturnType<typeof recordingLogger>) => [
  ...logger.warn.mock.calls,
  ...logger.error.mock.calls,
];

/** Wraps put so each call records `onPut()` first, then runs the real write. */
function watchPut(onPut: (rows: readonly CheckpointRow[]) => void) {
  const real = SqliteCheckpoints.prototype.put;
  return vi.spyOn(SqliteCheckpoints.prototype, "put").mockImplementation(function (
    this: SqliteCheckpoints,
    projectId,
    rows,
  ) {
    onPut(rows);
    return real.call(this, projectId, rows);
  });
}

describe("the engine logger reaches the cache upkeep (wiring)", () => {
  function rebootWith(logger: ReturnType<typeof recordingLogger>) {
    engine?.close();
    const booted = bootInProcess(dbPath(), { logger: logger as never });
    engine = booted.engine;
    return booted.app;
  }

  // Fails if boot.ts stops passing options.logger to rebuildStaleProjections.
  it("boot path: a failing non-busy put during backfill reaches the engine logger once", () => {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    engine?.close();
    vi.spyOn(SqliteCheckpoints.prototype, "put").mockImplementation(() => {
      throw FULL();
    });
    const logger = recordingLogger();
    const booted = bootInProcess(dbPath(), { logger: logger as never });
    engine = booted.engine;
    expect(problems(logger)).toHaveLength(1);
    expectNoBodies(problems(logger));
  });

  // Fails if routes.ts (or boot.ts registering it) stops passing the logger to stateAtSequence.
  it("route path: GET state with a failing non-busy cache write logs it and answers the right state", async () => {
    const logger = recordingLogger();
    const app = rebootWith(logger);
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    vi.spyOn(SqliteCheckpoints.prototype, "put").mockImplementation(() => {
      throw FULL();
    });
    const { status, body } = await getJson<{ state: ProjectState }>(
      app,
      "/v1/timelines/live:demo/state?at=1250",
    );
    expect(status).toBe(200);
    expect(body.state).toEqual(fullReplay(1250));
    expect(problems(logger)).toHaveLength(1);
    expectNoBodies(problems(logger));
  }, 30_000);
});

describe("logged fields are an allowlist: errcode plus a fixed description", () => {
  const SENTINEL = "SENTINEL-xyzzy-7731";
  const leaks = (calls: unknown[][]) => stringsIn(calls).some((t) => t.includes(SENTINEL));

  it.each([
    ["a sentinel in the message", SENTINEL],
    ["a state body in the message", canonicalJson(fullReplay(500))],
  ])("seek path: %s never reaches the logger", (_name, message) => {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    const logger = recordingLogger();
    vi.spyOn(storage().checkpoints(), "put").mockImplementation(() => {
      throw dbError(message, 13);
    });
    const options: StateAtOptions & { logger: typeof logger } = { logger };
    expect(stateAtSequence(storage(), PROJECT, 1250, options)).toEqual(fullReplay(1250));
    expect(logger.calls()).toHaveLength(1);
    expect(leaks(logger.calls())).toBe(false);
    expectNoBodies(logger.calls());
    expect(JSON.stringify(logger.calls())).toContain("13"); // errcode is kept
  });

  it("boot path: a sentinel in the message never reaches the logger", () => {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    const logger = recordingLogger();
    vi.spyOn(storage().checkpoints(), "put").mockImplementation(() => {
      throw dbError(SENTINEL, 13);
    });
    bootRebuild(storage(), domainReducer, { logger });
    expect(logger.calls()).toHaveLength(1);
    expect(leaks(logger.calls())).toBe(false);
    expect(JSON.stringify(logger.calls())).toContain("13");
  });
});

describe("a thrown null or undefined from the cache is a non-busy error", () => {
  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("seek path: %s does not fail the seek and is logged once", (_name, thrown) => {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    const logger = recordingLogger();
    vi.spyOn(storage().checkpoints(), "put").mockImplementation(() => {
      throw thrown;
    });
    const options: StateAtOptions & { logger: typeof logger } = { logger };
    expect(stateAtSequence(storage(), PROJECT, 1250, options)).toEqual(fullReplay(1250));
    expect(logger.calls()).toHaveLength(1);
    expectNoBodies(logger.calls());
  });

  it.each([
    ["null", null],
    ["undefined", undefined],
  ])("boot path: %s does not abort boot and is logged once", (_name, thrown) => {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    const logger = recordingLogger();
    vi.spyOn(storage().checkpoints(), "put").mockImplementation(() => {
      throw thrown;
    });
    expect(() => bootRebuild(storage(), domainReducer, { logger })).not.toThrow();
    expect(logger.calls()).toHaveLength(1);
  });
});

describe("a later batch failing mid-way", () => {
  // Pin on main (batches are separate transactions): earlier batches stay, one log line, seek right.
  it("keeps the earlier batches' rows, logs once for that write, and the seek answers", () => {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    const logger = recordingLogger();
    const real = SqliteCheckpoints.prototype.put;
    let calls = 0;
    vi.spyOn(SqliteCheckpoints.prototype, "put").mockImplementation(function (
      this: SqliteCheckpoints,
      projectId,
      rows,
    ) {
      calls++;
      if (calls === 2) throw FULL();
      return real.call(this, projectId, rows);
    });
    const options: StateAtOptions & { logger: typeof logger } = { logger, interval: 50 };
    expect(stateAtSequence(storage(), PROJECT, LOG_LENGTH, options)).toEqual(
      fullReplay(LOG_LENGTH),
    );
    expect(calls).toBeGreaterThanOrEqual(2);
    const kept = sequencesOf(PROJECT);
    expect(kept).toHaveLength(MAX_BATCH); // exactly the first batch survives
    expect(kept[0]).toBe(50);
    expect(logger.calls()).toHaveLength(1);
    expectNoBodies(logger.calls());
  });
});

describe("memory: checkpoint state is written as the fold goes, one batch at a time", () => {
  /** Rows produced so far from `applied` events folded at a checkpoint every `interval`. */
  const produced = (applied: number, interval: number) => Math.floor(applied / interval);

  // FAILS on main: every fresh row is held until the fold ends, then written in slices.
  it("cold seek: the first put happens before the fold ends, and at most 20 rows are ever held", () => {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    const counter = counting(domainReducer);
    const interval = 50;
    let written = 0;
    const heldAtPut: number[] = [];
    const appliedAtPut: number[] = [];
    watchPut((rows) => {
      appliedAtPut.push(counter.applied);
      heldAtPut.push(produced(counter.applied, interval) - written);
      written += rows.length;
    });
    stateAtSequence(storage(), PROJECT, LOG_LENGTH, { interval, reducer: counter.reducer });
    expect(counter.applied).toBe(LOG_LENGTH);
    expect(appliedAtPut[0]).toBeLessThan(LOG_LENGTH);
    expect(Math.max(...heldAtPut)).toBeLessThanOrEqual(MAX_BATCH);
    expect(written).toBe(52);
  }, 30_000);

  // FAILS on main: the backfill folds to the last missing checkpoint before its single put.
  it("boot backfill: the first put happens before the fold ends, and at most 20 rows are held", () => {
    const lively = dayEvents(LIVELY);
    seedLog(storage(), lively);
    db().exec("DELETE FROM checkpoints");
    const counter = counting(domainReducer);
    let written = 0;
    const heldAtPut: number[] = [];
    const appliedAtPut: number[] = [];
    watchPut((rows) => {
      appliedAtPut.push(counter.applied);
      heldAtPut.push(produced(counter.applied, 500) - written);
      written += rows.length;
    });
    rebuildStaleProjections(storage(), counter.reducer);
    expect(counter.applied).toBeGreaterThanOrEqual(lively.length - 500);
    expect(appliedAtPut[0]).toBeLessThan(lively.length - 500);
    expect(Math.max(...heldAtPut)).toBeLessThanOrEqual(MAX_BATCH);
    expect(written).toBe(Math.floor(lively.length / 500));
  }, 120_000);
});

// ---- Red round 3 (roborev re-review 6808): only the checkpoint write is best effort ----

describe("boot backfill: a failed read or reducer step is not a cache write failure", () => {
  function freshProjectionNoCheckpoints() {
    seedLog(storage(), events);
    db().exec("DELETE FROM checkpoints");
    expect(sequencesOf(PROJECT)).toEqual([]);
  }

  // FAILS on main: the catch wraps the replay loop, so the read error is swallowed and boot goes on.
  it("an event-log read error during backfill aborts boot (rebuildStaleProjections throws)", () => {
    freshProjectionNoCheckpoints();
    const logger = recordingLogger();
    const read = vi.spyOn(storage(), "events").mockImplementation(() => {
      throw new Error("event log unreadable");
    });
    const put = vi.spyOn(storage().checkpoints(), "put");
    expect(() => bootRebuild(storage(), domainReducer, { logger })).toThrow("event log unreadable");
    expect(read).toHaveBeenCalled();
    expect(put).not.toHaveBeenCalled();
  });

  // FAILS on main: same catch swallows a reducer throw.
  it("a reducer.apply throw during backfill aborts boot (rebuildStaleProjections throws)", () => {
    freshProjectionNoCheckpoints();
    const logger = recordingLogger();
    const broken: ProjectionReducer<ProjectState> = {
      ...domainReducer,
      apply: () => {
        throw new Error("reducer exploded");
      },
    };
    expect(() => bootRebuild(storage(), broken, { logger })).toThrow("reducer exploded");
  });

  // FAILS on main: a read failure partway through the fold is swallowed too.
  it("an event-log read error after some events were folded still aborts boot", () => {
    freshProjectionNoCheckpoints();
    const real = storage().events.bind(storage());
    vi.spyOn(storage(), "events").mockImplementation(function* (...args: Parameters<typeof real>) {
      let n = 0;
      for (const event of real(...args)) {
        if (++n > 100) throw new Error("event log unreadable");
        yield event;
      }
    });
    expect(() => bootRebuild(storage(), domainReducer, { logger: recordingLogger() })).toThrow(
      "event log unreadable",
    );
  });

  // Pin (passes on main): a non-busy put failure is still logged once and boot continues.
  it("a non-busy put failure still logs once and boot continues", () => {
    freshProjectionNoCheckpoints();
    const logger = recordingLogger();
    vi.spyOn(storage().checkpoints(), "put").mockImplementation(() => {
      throw FULL();
    });
    expect(() => bootRebuild(storage(), domainReducer, { logger })).not.toThrow();
    expect(logger.calls()).toHaveLength(1);
    expectNoBodies(logger.calls());
  });
});

// ---- M6.15 (#364): log dedupe on the seek path, and backfill pins ----
//
// Interface: dedupe is keyed by errcode and scoped to the logger it is given (a per-logger or
// per-engine registry), so a persistent failure logs once per errcode however many deletes or
// seeks hit it, while a different errcode still logs. Tests use a fresh logger each; a
// process-global Set that is never reset would break the M6.12 tests above (they expect one log
// per fresh failure with the same errcode), so scope the memory to the logger instead.

describe("seek path: a persistent cache failure is logged once per errcode, not once per delete", () => {
  beforeEach(() => seedLog(storage(), events));

  /** Fills the cache, then breaks the rows at `sequences` so a seek tries to delete each. */
  function breakRows(sequences: number[]) {
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
    for (const sequence of sequences) {
      db()
        .prepare("UPDATE checkpoints SET state_hash = 'bad' WHERE project_id = ? AND sequence = ?")
        .run(PROJECT, sequence);
    }
  }

  /** Deletes fail, and puts are swallowed so a seek cannot heal the broken row: it stays uncached. */
  const failDeletes = (error: () => Error) => {
    vi.spyOn(storage().checkpoints(), "put").mockImplementation(() => {});
    return vi.spyOn(storage().checkpoints(), "delete").mockImplementation(() => {
      throw error();
    });
  };

  // FAILS on main: the delete loop logs once per failing delete (3 here).
  it("one seek whose loop fails three deletes logs once", () => {
    breakRows([1500, 2000, 2500]);
    const del = failDeletes(FULL);
    const logger = recordingLogger();
    const state = stateAtSequence(storage(), PROJECT, LOG_LENGTH, { logger });
    expect(del).toHaveBeenCalledTimes(3);
    expect(state).toEqual(fullReplay(LOG_LENGTH));
    expect(logger.calls()).toHaveLength(1);
    expectNoBodies(logger.calls());
  });

  // FAILS on main: every uncached seek logs again (5 seeks, 5 logs).
  it("five seeks that hit the same failing delete log once", () => {
    breakRows([1000]);
    const del = failDeletes(READONLY);
    const logger = recordingLogger();
    for (let i = 0; i < 5; i++) {
      expect(stateAtSequence(storage(), PROJECT, 1250, { logger })).toEqual(fullReplay(1250));
    }
    expect(del).toHaveBeenCalledTimes(5); // the upkeep is still attempted every time
    expect(logger.calls()).toHaveLength(1);
    expectNoBodies(logger.calls());
  });

  // FAILS on main (6 lines): two errcodes, two lines, however many seeks.
  it("a different errcode is still logged: SQLITE_FULL then SQLITE_READONLY give two lines", () => {
    breakRows([1000]);
    const logger = recordingLogger();
    failDeletes(FULL);
    for (let i = 0; i < 3; i++) stateAtSequence(storage(), PROJECT, 1250, { logger });
    vi.restoreAllMocks();
    failDeletes(READONLY);
    for (let i = 0; i < 3; i++) stateAtSequence(storage(), PROJECT, 1250, { logger });
    expect(logger.calls()).toHaveLength(2);
    expectNoBodies(logger.calls());
  });

  // Pin: the first failure is never swallowed.
  it("the first failing delete is logged", () => {
    breakRows([1000]);
    failDeletes(FULL);
    const logger = recordingLogger();
    stateAtSequence(storage(), PROJECT, 1250, { logger });
    expect(logger.calls()).toHaveLength(1);
  });
});

describe("boot backfill pins (M6.15): mid-way failure and another project's state", () => {
  // Pin (passes on main): batches are separate puts, so a failure on the second keeps the first.
  it("a put failing on the second batch keeps the first batch and logs one line", () => {
    const lively = dayEvents(LIVELY); // 100 checkpoints at the 500 interval: five batches of 20
    seedLog(storage(), lively);
    db().exec("DELETE FROM checkpoints");
    const logger = recordingLogger();
    const real = SqliteCheckpoints.prototype.put;
    let calls = 0;
    vi.spyOn(SqliteCheckpoints.prototype, "put").mockImplementation(function (
      this: SqliteCheckpoints,
      projectId,
      rows,
    ) {
      calls++;
      if (calls === 2) throw FULL();
      return real.call(this, projectId, rows);
    });
    expect(() => bootRebuild(storage(), domainReducer, { logger })).not.toThrow();
    expect(calls).toBe(2); // the backfill stops after the failure
    const kept = sequencesOf(PROJECT);
    expect(kept).toHaveLength(MAX_BATCH);
    expect(kept[0]).toBe(500);
    expect(kept[MAX_BATCH - 1]).toBe(500 * MAX_BATCH);
    expect(logger.calls()).toHaveLength(1);
    expectNoBodies(logger.calls());
  }, 120_000);

  /** A self-consistent state (right version, head 1000, valid hash) of another project. */
  const foreign = () => {
    let state = domainReducer.initial("other-project");
    for (const event of dayEvents(CALM, "other-project").slice(0, 1000)) {
      state = domainReducer.apply(state, event);
    }
    expect(state.head).toBe(1000);
    return state;
  };

  // Pin (passes on main): trusted() binds a row to its project.
  it("trusted() rejects a row whose state belongs to another project", () => {
    const state = foreign();
    const row: CheckpointRow = {
      sequence: 1000,
      reducerVersion: REDUCER_VERSION,
      stateHash: stateHash(REDUCER_VERSION, state),
      stateJson: JSON.stringify(state),
    };
    expect(trusted(row, REDUCER_VERSION, "other-project")).toEqual(state); // sanity: valid there
    expect(trusted(row, REDUCER_VERSION, PROJECT)).toBeUndefined();
  });

  // Pin (passes on main): the backfill replaces such a row, and a seek never loads it.
  it("a stored row holding another project's state at 1000 is replaced at boot", () => {
    seedLog(storage(), events);
    rebuildStaleProjections(storage(), domainReducer);
    const state = foreign();
    db()
      .prepare(
        "UPDATE checkpoints SET state_json = ?, state_hash = ? WHERE project_id = ? AND sequence = 1000",
      )
      .run(JSON.stringify(state), stateHash(REDUCER_VERSION, state), PROJECT);
    rebuildStaleProjections(storage(), domainReducer);
    const row = db()
      .prepare("SELECT state_json FROM checkpoints WHERE project_id = ? AND sequence = 1000")
      .get(PROJECT) as unknown as { state_json: string };
    expect(JSON.parse(row.state_json)).toEqual(fullReplay(1000));
    expect(stateAtSequence(storage(), PROJECT, 1250)).toEqual(fullReplay(1250));
  });
});
