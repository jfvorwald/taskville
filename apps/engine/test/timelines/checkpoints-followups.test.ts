import { DatabaseSync } from "node:sqlite";
import { stateHash } from "@taskville/domain/hash";
import {
  initialState,
  type ProjectState,
  REDUCER_VERSION,
  reduce,
} from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { domainReducer } from "../../src/ingest/index.ts";
import {
  openStorage,
  type ProjectionReducer,
  rebuildStaleProjections,
} from "../../src/storage/index.ts";
import { stateAtSequence } from "../../src/timelines/checkpoints.ts";
import { seedLog } from "./day-log.ts";
import {
  addProject,
  bootInProcess,
  dayEvents,
  type Engine,
  ingest,
  input,
  useDbPath,
} from "./helpers.ts";

// M6.11 (#332): follow-ups from the M6.08 confirming review. RED phase tests. Complements
// checkpoints.test.ts; each describe says whether it already passes on main (pins) or fails.
//
// Intended behavior for the implementer:
// - SqliteCheckpoints.withWaitBudget: each write waits min(connection's own busy_timeout, what is
//   left of the 250 ms budget); the previous busy_timeout (5000 by default) is always restored.
// - prune() runs a read-only probe first and takes the write lock only if a row needs pruning.
// - trusted() also requires state.head === row.sequence and state.projectId === the row's project.
// - Boot (rebuildStaleProjections, which also covers the first boot after a reducer version
//   change) writes the replay checkpoints for every project it rebuilds, so a seek right after
//   boot does not fold from zero.

const LOG_LENGTH = 2600;
const events: StoredEnvelope[] = dayEvents().slice(0, LOG_LENGTH);
const PROJECT = events[0]?.projectId ?? "demo";

function fullReplay(upTo: number): ProjectState {
  let state = domainReducer.initial(PROJECT);
  for (const event of events.slice(0, upTo)) state = domainReducer.apply(state, event);
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

const dbPath = useDbPath();
let engine: Engine | undefined;
let app: ReturnType<typeof bootInProcess>["app"];
let raw: DatabaseSync | undefined;

beforeEach(() => {
  const booted = bootInProcess(dbPath());
  engine = booted.engine;
  app = booted.app;
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
const sequencesOf = (project: string): number[] =>
  (
    db()
      .prepare("SELECT sequence FROM checkpoints WHERE project_id = ? ORDER BY sequence")
      .all(project) as unknown as { sequence: number }[]
  ).map((r) => r.sequence);
const timed = <T>(fn: () => T): { value: T; ms: number } => {
  const started = performance.now();
  const value = fn();
  return { value, ms: performance.now() - started };
};

/**
 * The time a foreign write lock adds to `run`, in ms. `prepare` puts the data in the same state
 * before each of two runs: one unlocked (the baseline: fold, JSON, sha256, disk) and one with the
 * lock held on `db()`. The difference is lock wait only, so machine load does not move it.
 * Returns the locked run's value too.
 */
function lockCost<T>(prepare: () => void, run: () => T): { extra: number; value: T } {
  prepare();
  const baseline = timed(run).ms;
  prepare();
  db().exec("BEGIN IMMEDIATE");
  let locked: { value: T; ms: number };
  try {
    locked = timed(run);
  } finally {
    db().exec("ROLLBACK");
  }
  return { extra: locked.ms - baseline, value: locked.value };
}
const clearCache = () => void db().exec("DELETE FROM checkpoints");

/** How long a write on `conn` waits for a foreign lock, in ms (the lock is held on `db()`). */
function writeWaitMs(conn: ReturnType<typeof openStorage>): number {
  const started = performance.now();
  try {
    conn.transaction(() => {});
  } catch {
    // Expected: the lock is held, so the write gives up after its busy timeout.
  }
  return performance.now() - started;
}

// Passes on main (pins), except where noted per test.
describe("busy_timeout is restored after stateAtSequence", () => {
  beforeEach(() => seedLog(storage(), events));

  it("healthy path: a later writer on the connection still waits the full 5000 ms", () => {
    stateAtSequence(storage(), PROJECT, 1250);
    db().exec("BEGIN IMMEDIATE");
    try {
      expect(writeWaitMs(storage())).toBeGreaterThan(4500);
    } finally {
      db().exec("ROLLBACK");
    }
  }, 30_000);

  it("foreign-lock path: the timeout is back to 5000 ms after upkeep gave up", () => {
    const { extra, value } = lockCost(clearCache, () => stateAtSequence(storage(), PROJECT, 1250));
    expect(value).toEqual(fullReplay(1250));
    expect(extra).toBeLessThan(400); // the 250 ms budget is shared by all upkeep steps
    db().exec("BEGIN IMMEDIATE");
    try {
      expect(writeWaitMs(storage())).toBeGreaterThan(4500);
    } finally {
      db().exec("ROLLBACK");
    }
  }, 30_000);

  it("the budget is shared: even with bad rows to prune and rows to write, total stays under 400 ms", () => {
    const damaged = () => {
      clearCache();
      stateAtSequence(storage(), PROJECT, LOG_LENGTH);
      db().prepare("UPDATE checkpoints SET state_json = 'x' WHERE sequence IN (500, 1000)").run();
    };
    const { extra, value } = lockCost(damaged, () =>
      stateAtSequence(storage(), PROJECT, LOG_LENGTH),
    );
    expect(value).toEqual(fullReplay(LOG_LENGTH));
    expect(extra).toBeLessThan(400);
  }, 30_000);

  // FAILS on main: the budget sets busy_timeout to the remaining 250 ms even on a connection
  // whose own timeout is smaller, so it raises it. Math.min keeps the smaller one.
  it("never raises a connection whose own busy_timeout is smaller than the budget", () => {
    const impatient = openStorage(dbPath(), { busyTimeoutMs: 30 });
    try {
      // Writing the missing rows needs the lock: it waits about 30 ms, not the 250 ms budget.
      const { extra, value } = lockCost(clearCache, () =>
        stateAtSequence(impatient, PROJECT, 1250),
      );
      expect(value).toEqual(fullReplay(1250));
      expect(extra).toBeLessThan(150);
    } finally {
      impatient.close();
    }
  }, 30_000);
});

describe("prune takes the write lock only when there is something to prune", () => {
  beforeEach(() => {
    seedLog(storage(), events);
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
  });

  // FAILS on main: prune always runs BEGIN IMMEDIATE and waits out the budget (250 ms).
  it("prune returns 0 promptly while a foreign connection holds the write lock", () => {
    const { extra, value } = lockCost(
      () => {},
      () => storage().checkpoints().prune(PROJECT, REDUCER_VERSION, LOG_LENGTH),
    );
    expect(value).toBe(0);
    expect(extra).toBeLessThan(100);
  });

  // FAILS on main, same reason: a fully populated cache needs no upkeep at all.
  it("a seek over a fully populated, healthy cache is not delayed by a foreign write lock", () => {
    const { extra, value } = lockCost(
      () => {},
      () => stateAtSequence(storage(), PROJECT, 1250),
    );
    expect(value).toEqual(fullReplay(1250));
    expect(extra).toBeLessThan(100);
  });

  // Pin (passes on main): when there is something to prune, prune still does it.
  it("still removes a row of another version, one beyond the head, and a non-object row", () => {
    const row = db()
      .prepare("SELECT state_hash, state_json FROM checkpoints WHERE sequence = 500")
      .get() as unknown as { state_hash: string; state_json: string };
    const insert = db().prepare(
      "INSERT INTO checkpoints (project_id, sequence, reducer_version, state_hash, state_json) VALUES (?, ?, ?, ?, ?)",
    );
    insert.run(PROJECT, 501, REDUCER_VERSION - 1, row.state_hash, row.state_json);
    insert.run(PROJECT, 9000, REDUCER_VERSION, row.state_hash, row.state_json);
    insert.run(PROJECT, 502, REDUCER_VERSION, row.state_hash, "null");
    expect(storage().checkpoints().prune(PROJECT, REDUCER_VERSION, LOG_LENGTH)).toBe(3);
    expect(sequencesOf(PROJECT)).toEqual([500, 1000, 1500, 2000, 2500]);
  });
});

// Pins (pass on main from M6.08).
describe("a checkpoint written in the ingest transaction rolls back with it", () => {
  it("a transaction that writes a checkpoint and then throws leaves no row", () => {
    addProject(storage(), "rb");
    const state = domainReducer.initial("rb");
    expect(() =>
      storage().transaction((tx) => {
        tx.writeCheckpoint({
          projectId: "rb",
          sequence: 1,
          reducerVersion: REDUCER_VERSION,
          state,
        });
        throw new Error("abort");
      }),
    ).toThrow("abort");
    expect(sequencesOf("rb")).toEqual([]);
  });

  /** 499 inputs after project.created leaves the head at 500 only when the 499th is accepted. */
  const upTo = (project: string, count: number) =>
    Array.from({ length: count }, (_, i) => input(`n-${i}`, { projectId: project }));

  it("a duplicate of the event at sequence 500, in the same or a later batch, leaves one row", async () => {
    addProject(storage(), "dup");
    const batch = upTo("dup", 499);
    await ingest(app, [...batch, batch[498]]);
    expect(storage().head("dup")).toBe(500);
    expect(sequencesOf("dup")).toEqual([500]);
    await ingest(app, [batch[498], batch[497]]);
    expect(storage().head("dup")).toBe(500);
    expect(sequencesOf("dup")).toEqual([500]);
  });

  it("a rejected event next to sequence 500 leaves one row at 500 and none for the rejection", async () => {
    addProject(storage(), "rej");
    const batch = upTo("rej", 498); // head 499
    const bad = input("bad", { projectId: "rej", type: "no.such.type" });
    await ingest(app, [...batch, bad]);
    expect(storage().head("rej")).toBe(499);
    expect(sequencesOf("rej")).toEqual([]);
    await ingest(app, [bad, input("n-499", { projectId: "rej" }), bad]);
    expect(storage().head("rej")).toBe(500);
    expect(sequencesOf("rej")).toEqual([500]);
  });
});

describe("trusted() binds the state to its row", () => {
  beforeEach(() => {
    seedLog(storage(), events);
    stateAtSequence(storage(), PROJECT, LOG_LENGTH);
  });

  /** Replaces the row at 1000 with `forged` state and a hash that matches that state. */
  function forgeRow1000(forged: ProjectState) {
    const json = JSON.stringify(forged);
    db()
      .prepare(
        "UPDATE checkpoints SET state_json = ?, state_hash = ? WHERE project_id = ? AND sequence = 1000",
      )
      .run(json, stateHash(REDUCER_VERSION, forged), PROJECT);
  }

  // FAIL on main: a self-consistent row is trusted whatever its state says about its position.
  it("a row whose state.head is not the row's sequence is ignored", () => {
    forgeRow1000(fullReplay(500)); // head 500 stored under sequence 1000
    expect(stateAtSequence(storage(), PROJECT, 1250)).toEqual(fullReplay(1250));
  });

  it("a row whose state.projectId is not the row's project is ignored", () => {
    forgeRow1000({ ...fullReplay(1000), projectId: "other" });
    expect(stateAtSequence(storage(), PROJECT, 1250)).toEqual(fullReplay(1250));
  });

  it("an honest row is still used (replays at most 250 events)", () => {
    const counter = counting(domainReducer);
    stateAtSequence(storage(), PROJECT, 1250, { reducer: counter.reducer });
    expect(counter.applied).toBeLessThanOrEqual(250);
  });
});

describe("boot writes checkpoints for existing logs", () => {
  /** Seeds the log, then reopens the engine so the boot rebuild runs over it. */
  function rebootOverLog() {
    seedLog(storage(), events);
    engine?.close();
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    app = booted.app;
  }

  // FAILS on main: rebuildStaleProjections writes the projection only.
  it("a boot rebuild leaves a trusted checkpoint at every multiple of 500 with no reads", () => {
    rebootOverLog();
    expect(sequencesOf(PROJECT)).toEqual([500, 1000, 1500, 2000, 2500]);
    for (const row of db()
      .prepare(
        "SELECT sequence, reducer_version, state_hash, state_json FROM checkpoints WHERE project_id = ?",
      )
      .all(PROJECT) as unknown as {
      sequence: number;
      reducer_version: number;
      state_hash: string;
      state_json: string;
    }[]) {
      expect(row.reducer_version).toBe(REDUCER_VERSION);
      expect(JSON.parse(row.state_json)).toEqual(fullReplay(row.sequence));
      expect(row.state_hash).toBe(stateHash(REDUCER_VERSION, fullReplay(row.sequence)));
    }
  });

  // FAILS on main: the first seek after boot folds all 1250 events.
  it("a seek right after boot replays at most 250 events", () => {
    rebootOverLog();
    const counter = counting(domainReducer);
    const state = stateAtSequence(storage(), PROJECT, 1250, { reducer: counter.reducer });
    expect(counter.applied).toBeLessThanOrEqual(250);
    expect(state).toEqual(fullReplay(1250));
  });

  // FAILS on main: a reducer version change rebuilds the projection but no checkpoints.
  it("the first boot after a reducer version change writes checkpoints for the new version", () => {
    seedLog(storage(), events);
    const next: ProjectionReducer<ProjectState> = {
      version: REDUCER_VERSION + 1,
      initial: (projectId) => ({ ...initialState(projectId), reducerVersion: REDUCER_VERSION + 1 }),
      apply: (state, event) => ({ ...reduce(state, event), reducerVersion: REDUCER_VERSION + 1 }),
    };
    rebuildStaleProjections(storage(), domainReducer); // the old version's projection (and cache)
    expect(rebuildStaleProjections(storage(), next)).toContain(PROJECT);
    const rows = db()
      .prepare("SELECT sequence, reducer_version FROM checkpoints WHERE project_id = ?")
      .all(PROJECT) as unknown as { sequence: number; reducer_version: number }[];
    expect(rows.map((r) => r.sequence).sort((a, b) => a - b)).toEqual([
      500, 1000, 1500, 2000, 2500,
    ]);
    expect(rows.every((r) => r.reducer_version === REDUCER_VERSION + 1)).toBe(true);
  });

  // Pin: a project whose projection is fresh is not rebuilt, so its checkpoints are left alone.
  it("a second boot with nothing stale changes no checkpoint rows", () => {
    rebootOverLog();
    const before = sequencesOf(PROJECT);
    engine?.close();
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    app = booted.app;
    expect(sequencesOf(PROJECT)).toEqual(before);
  });
});

// Red round 2 (roborev panel 6682, PR #345): the boot backfill is a disposable cache, so a busy
// write lock must never abort startup. Missing checkpoints are left for the lazy path.
describe("boot backfill is best effort under a busy write lock", () => {
  /** A fresh projection over a log with no checkpoints (a log that predates them). */
  function freshProjectionNoCheckpoints() {
    seedLog(storage(), events);
    rebuildStaleProjections(storage(), domainReducer);
    db().exec("DELETE FROM checkpoints");
    expect(sequencesOf(PROJECT)).toEqual([]);
  }

  it("rebuildStaleProjections does not throw, keeps the projection, and writes nothing", () => {
    freshProjectionNoCheckpoints();
    const before = storage().projection(PROJECT);
    const impatient = openStorage(dbPath(), { busyTimeoutMs: 100 });
    try {
      const { extra, value } = lockCost(clearCache, () => {
        let rebuilt: string[] | undefined;
        expect(() => {
          rebuilt = rebuildStaleProjections(impatient, domainReducer);
        }).not.toThrow();
        return rebuilt;
      });
      expect(value).not.toContain(PROJECT);
      expect(extra).toBeLessThan(1000);
    } finally {
      impatient.close();
    }
    expect(storage().projection(PROJECT)).toEqual(before);
    expect(sequencesOf(PROJECT)).toEqual([]);
  }, 30_000);

  // The M6.11 guard that a non-busy error is rethrown was replaced in M6.12 (#347): the backfill
  // now logs it and boot continues. See checkpoints-hardening.test.ts.

  it("after a skipped backfill, a seek fills the checkpoints, and a later unlocked boot keeps them", () => {
    freshProjectionNoCheckpoints();
    const impatient = openStorage(dbPath(), { busyTimeoutMs: 100 });
    db().exec("BEGIN IMMEDIATE");
    try {
      expect(() => rebuildStaleProjections(impatient, domainReducer)).not.toThrow();
    } finally {
      db().exec("ROLLBACK");
      impatient.close();
    }
    expect(sequencesOf(PROJECT)).toEqual([]);
    expect(stateAtSequence(storage(), PROJECT, 1250)).toEqual(fullReplay(1250));
    expect(sequencesOf(PROJECT)).toEqual([500, 1000]);
    engine?.close();
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    app = booted.app;
    expect(sequencesOf(PROJECT)).toEqual([500, 1000, 1500, 2000, 2500]);
    expect(stateAtSequence(storage(), PROJECT, 1250)).toEqual(fullReplay(1250));
  }, 30_000);
});
