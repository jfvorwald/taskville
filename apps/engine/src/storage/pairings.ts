import { randomUUID } from "node:crypto";
import type { PairingRecords } from "../auth/pairing.ts";
import type { Database } from "./sqlite.ts";

/**
 * `PairingRecords` over the `pairings` table. Stores only SHA-256 digests of
 * session secrets (data-model.md). Built here but not passed to the engine by
 * default: whether to persist pairings at all is decision #113, settled when
 * `serve` (#16) composes storage with the HTTP app.
 */
export class SqlitePairingRecords implements PairingRecords {
  readonly #db: Database;
  readonly #now: () => Date;

  constructor(db: Database, now: () => Date) {
    this.#db = db;
    this.#now = now;
  }

  list(): readonly string[] {
    return this.#db
      .prepare("SELECT secret_hash FROM pairings ORDER BY created_at, rowid")
      .all()
      .map((row) => String(row.secret_hash));
  }

  add(secretHash: string): void {
    this.#db
      .prepare("INSERT INTO pairings (id, secret_hash, created_at) VALUES (?, ?, ?)")
      .run(randomUUID(), secretHash, this.#now().toISOString());
  }

  clear(): number {
    return Number(this.#db.prepare("DELETE FROM pairings").run().changes);
  }
}
