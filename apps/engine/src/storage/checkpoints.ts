import type { Database } from "./sqlite.ts";

/** One stored checkpoint: the reducer state after events 1..sequence. */
export interface CheckpointRow {
  sequence: number;
  reducerVersion: number;
  stateHash: string;
  stateJson: string;
}

/**
 * The `checkpoints` table (ARCHITECTURE.md 7.4): disposable caches of reducer state, never read
 * as truth. The caller decides whether a row is trustworthy; this class only stores, lists, and
 * deletes. Writes run in their own transaction.
 */
export class SqliteCheckpoints {
  readonly #db: Database;

  constructor(db: Database) {
    this.#db = db;
  }

  /**
   * Drops rows that cannot be used for `reducerVersion` against a log of `head` events: another
   * version, a sequence outside 1..head, or state text that does not start like a JSON object
   * (constant time per row; a row is parsed and hash-checked only when a seek would use it).
   * Returns the number removed.
   */
  prune(projectId: string, reducerVersion: number, head: number): number {
    return this.#write(() =>
      Number(
        this.#db
          .prepare(
            `DELETE FROM checkpoints WHERE project_id = ? AND (reducer_version != ?
                 OR sequence > ? OR substr(state_json, 1, 1) != '{')`,
          )
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

  #write<T>(fn: () => T): T {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
