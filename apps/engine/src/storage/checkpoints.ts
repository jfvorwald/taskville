import { stateHash } from "@taskville/domain/hash";
import type { ProjectState } from "@taskville/domain/reducer";
import type { Database } from "./sqlite.ts";

/** Events between checkpoints (ARCHITECTURE.md 7.4). */
export const CHECKPOINT_INTERVAL = 500;

/** The longest cache upkeep waits, in total, for another connection's write lock. */
export const UPKEEP_WAIT_MS = 250;

/** The most checkpoint rows one `put` writes, so no single transaction or batch holds them all. */
export const CHECKPOINT_BATCH = 20;

/** The one logging method cache upkeep needs; a pino logger satisfies it. */
export interface UpkeepLogger {
  warn(obj: object, msg: string): void;
}

/** One stored checkpoint: the reducer state after events 1..sequence. */
export interface CheckpointRow {
  sequence: number;
  reducerVersion: number;
  stateHash: string;
  stateJson: string;
}

/** The state if `row` is trustworthy for a reducer of `version`: right version, parses, belongs to this project at this head, and matches its hash. */
export function trusted(
  row: CheckpointRow,
  version: number,
  projectId: string,
): ProjectState | undefined {
  if (row.reducerVersion !== version) return undefined;
  try {
    const state = JSON.parse(row.stateJson) as ProjectState;
    if (state.head !== row.sequence || state.projectId !== projectId) return undefined;
    return stateHash(version, state) === row.stateHash ? state : undefined;
  } catch {
    return undefined;
  }
}

/** Writes `rows` in batches of `CHECKPOINT_BATCH`; the first failing batch throws and later ones are not tried. */
export function putInBatches(
  cache: SqliteCheckpoints,
  projectId: string,
  rows: readonly CheckpointRow[],
): void {
  for (let i = 0; i < rows.length; i += CHECKPOINT_BATCH) {
    cache.put(projectId, rows.slice(i, i + CHECKPOINT_BATCH));
  }
}

/**
 * The `checkpoints` table (ARCHITECTURE.md 7.4): disposable caches of reducer state, never read
 * as truth. The caller decides whether a row is trustworthy; this class only stores, lists, and
 * deletes. Writes run in their own transaction, or in the caller's if one is open (the ingest
 * commit).
 */
export class SqliteCheckpoints {
  readonly #db: Database;
  #remaining: number | undefined;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Drops rows that cannot be used for `reducerVersion` against a log of `head` events: another
   * version, a sequence outside 1..head, or state text that does not start like a JSON object
   * (a cheap check per row, no parsing; a row is parsed and hash-checked only when a seek would
   * use it). A read-only probe runs first and the write lock is taken only when it finds a row to
   * drop, so a healthy cache never waits on another writer. Returns the number removed.
   */
  prune(projectId: string, reducerVersion: number, head: number): number {
    const unusable = `project_id = ? AND (reducer_version != ?
                 OR sequence > ? OR substr(state_json, 1, 1) != '{')`;
    const found = this.#db
      .prepare(`SELECT 1 FROM checkpoints WHERE ${unusable} LIMIT 1`)
      .get(projectId, reducerVersion, head);
    if (!found) return 0;
    return this.#write(() =>
      Number(
        this.#db
          .prepare(`DELETE FROM checkpoints WHERE ${unusable}`)
          .run(projectId, reducerVersion, head).changes,
      ),
    );
  }

  /** Every stored sequence for the project, ascending. */
  sequences(projectId: string): number[] {
    return this.#db
      .prepare("SELECT sequence FROM checkpoints WHERE project_id = ? ORDER BY sequence")
      .all(projectId)
      .map((row) => Number(row.sequence));
  }

  get(projectId: string, sequence: number): CheckpointRow | undefined {
    const row = this.#db
      .prepare(
        `SELECT sequence, reducer_version, state_hash, state_json FROM checkpoints
         WHERE project_id = ? AND sequence = ?`,
      )
      .get(projectId, sequence);
    if (!row) return undefined;
    return {
      sequence: Number(row.sequence),
      reducerVersion: Number(row.reducer_version),
      stateHash: String(row.state_hash),
      stateJson: String(row.state_json),
    };
  }

  delete(projectId: string, sequence: number): void {
    this.#write(() =>
      this.#db
        .prepare("DELETE FROM checkpoints WHERE project_id = ? AND sequence = ?")
        .run(projectId, sequence),
    );
  }

  /** Inserts or replaces the given rows in one transaction. */
  put(projectId: string, rows: readonly CheckpointRow[]): void {
    if (rows.length === 0) return;
    this.#write(() => {
      const insert = this.#db.prepare(
        `INSERT OR REPLACE INTO checkpoints
           (project_id, sequence, reducer_version, state_hash, state_json) VALUES (?, ?, ?, ?, ?)`,
      );
      for (const row of rows) {
        insert.run(projectId, row.sequence, row.reducerVersion, row.stateHash, row.stateJson);
      }
    });
  }

  /**
   * Runs `fn` with every write inside it drawing on one shared lock-wait budget of `ms`: a write
   * waits at most what is left (the connection's busy timeout is lowered for it and restored
   * after), time spent waiting is subtracted, and a write throws at once when nothing is left.
   * The engine's default busy timeout is untouched for every other writer.
   */
  withWaitBudget<T>(ms: number, fn: () => T): T {
    const previous = this.#remaining;
    this.#remaining = ms;
    try {
      return fn();
    } finally {
      this.#remaining = previous;
    }
  }

  #write<T>(fn: () => T): T {
    // Inside the caller's transaction (the ingest commit) the lock is already held.
    if (this.#db.isTransaction) return fn();
    const restore = this.#limitWait();
    try {
      const began = performance.now();
      try {
        this.#db.exec("BEGIN IMMEDIATE");
      } finally {
        if (this.#remaining !== undefined) this.#remaining -= performance.now() - began;
      }
      try {
        const result = fn();
        this.#db.exec("COMMIT");
        return result;
      } catch (error) {
        if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
        throw error;
      }
    } finally {
      restore();
    }
  }

  /** Lowers the busy timeout to the remaining budget (never raising the connection's own), if there is one; returns the undo. */
  #limitWait(): () => void {
    if (this.#remaining === undefined) return () => {};
    const remaining = Math.floor(this.#remaining);
    if (remaining <= 0) throw new Error("checkpoint upkeep skipped: wait budget spent");
    const previous = Number(this.#db.prepare("PRAGMA busy_timeout").get()?.timeout);
    const left = Math.min(previous, remaining);
    this.#db.exec(`PRAGMA busy_timeout = ${left}`);
    return () => this.#db.exec(`PRAGMA busy_timeout = ${previous}`);
  }
}
