import { canonicalJson, sha256Hex } from "@taskville/domain/hash";
import type { StoredEnvelope } from "@taskville/protocol";
import type { PairingRecords } from "../auth/pairing.ts";
import { StorageError } from "./errors.ts";
import { secureDatabaseFiles } from "./file-mode.ts";
import { currentSchemaVersion, migrate } from "./migrations.ts";
import { SqlitePairingRecords } from "./pairings.ts";
import { Database, type Statement } from "./sqlite.ts";

/**
 * SQLite memory and WAL settings (#166), set on every connection the engine opens:
 * - the page cache is capped at 2 MiB (SQLite's default is about 2,000 KiB; set explicitly so
 *   native memory has a known bound),
 * - the WAL is checkpointed every 1,000 pages (SQLite's default, explicit), and
 * - after a checkpoint the `-wal` file is truncated to at most 4 MiB, so it does not keep the
 *   largest size it ever reached.
 */
export const PAGE_CACHE_KIB = 2048;
export const WAL_AUTOCHECKPOINT_PAGES = 1000;
export const JOURNAL_SIZE_LIMIT_BYTES = 4 * 1024 * 1024;

/** The pragmas `Storage.pragma` reads back (tests and diagnostics). */
export type StoragePragma = "cache_size" | "wal_autocheckpoint" | "journal_size_limit";

/** A projection's stored version, head, and state hash, without its state. */
export interface ProjectionMeta {
  reducerVersion: number;
  head: number;
  stateHash: string;
}

export interface StorageOptions {
  /** Clock for bookkeeping timestamps (migrations, pairings). Defaults to the system clock. */
  now?: () => Date;
  /** How long a writer waits for the lock before failing, in milliseconds. Default 5,000. */
  busyTimeoutMs?: number;
}

export interface ProjectRecord {
  id: string;
  name: string;
  createdAt: string;
  roots: string[];
  builtin: boolean;
  /** Ingest sequence of the project's last event, 0 before the first. */
  head: number;
}

export interface NewProject {
  id: string;
  name: string;
  createdAt: string;
  roots: readonly string[];
  builtin: boolean;
}

export interface ProjectionRecord<S = unknown> {
  projectId: string;
  reducerVersion: number;
  head: number;
  stateHash: string;
  state: S;
}

export interface ProjectionWrite {
  projectId: string;
  reducerVersion: number;
  /** Must equal the project head after this transaction's events. */
  head: number;
  state: unknown;
}

export interface StoredEventRecord {
  eventId: string;
  ingestSequence: number;
  contentHash: string;
  envelope: StoredEnvelope;
}

/** Reads available both inside and outside a transaction. */
export interface StorageReads {
  project(id: string): ProjectRecord | undefined;
  projects(): ProjectRecord[];
  /** The project head, or undefined for an unknown project. */
  head(projectId: string): number | undefined;
  projection<S = unknown>(projectId: string): ProjectionRecord<S> | undefined;
  /** The stored projection's version, head, and stateHash, without reading or parsing its state. */
  projectionMeta(projectId: string): ProjectionMeta | undefined;
  findEventBySourceKey(
    projectId: string,
    sourceId: string,
    sourceEventId: string,
  ): StoredEventRecord | undefined;
  /** The project's events with ingest sequence above `afterSequence`, in sequence order. */
  events(projectId: string, afterSequence?: number): IterableIterator<StoredEnvelope>;
}

/**
 * The write side, valid only inside `Storage.transaction`. There is no method
 * that updates or deletes an event.
 */
export interface StorageTransaction extends StorageReads {
  insertProject(project: NewProject): void;
  /**
   * Appends one event. `envelope.ingestSequence` must be the project head + 1;
   * the head advances with the insert. `contentHash` is the dedupe hash
   * (research R-6), 64 lowercase hex characters.
   */
  appendEvent(envelope: StoredEnvelope, contentHash: string): void;
  /** Writes the project's projection and returns its stateHash. */
  writeProjection(projection: ProjectionWrite): string;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;

interface ProjectRow {
  id: string;
  name: string;
  created_at: string;
  roots_json: string;
  builtin: number;
  head: number;
}

interface ProjectionRow {
  project_id: string;
  reducer_version: number;
  head: number;
  state_hash: string;
  state_json: string;
}

function toProject(row: ProjectRow): ProjectRecord {
  return {
    id: row.id,
    name: row.name,
    createdAt: row.created_at,
    roots: JSON.parse(row.roots_json) as string[],
    builtin: row.builtin === 1,
    head: row.head,
  };
}

function prepareStatements(db: Database) {
  const prepare = (sql: string): Statement => db.prepare(sql);
  return {
    project: prepare("SELECT * FROM projects WHERE id = ?"),
    projects: prepare("SELECT * FROM projects ORDER BY id"),
    head: prepare("SELECT head FROM projects WHERE id = ?"),
    insertProject: prepare(
      "INSERT INTO projects (id, name, created_at, roots_json, builtin) VALUES (?, ?, ?, ?, ?)",
    ),
    projection: prepare("SELECT * FROM projections WHERE project_id = ?"),
    projectionMeta: prepare(
      "SELECT reducer_version, head, state_hash FROM projections WHERE project_id = ?",
    ),
    writeProjection: prepare(
      `INSERT INTO projections (project_id, reducer_version, head, state_hash, state_json)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (project_id) DO UPDATE SET reducer_version = excluded.reducer_version,
         head = excluded.head, state_hash = excluded.state_hash, state_json = excluded.state_json`,
    ),
    bySourceKey: prepare(
      `SELECT event_id, ingest_sequence, content_hash, envelope_json FROM events
       WHERE project_id = ? AND source_id = ? AND source_event_id = ?`,
    ),
    events: prepare(
      `SELECT envelope_json FROM events WHERE project_id = ? AND ingest_sequence > ?
       ORDER BY ingest_sequence`,
    ),
    appendEvent: prepare(
      `INSERT INTO events (project_id, ingest_sequence, event_id, source_id, source_event_id,
         source_sequence, occurred_at, received_at, type, schema_version, provenance,
         content_hash, envelope_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ),
  };
}

type Statements = ReturnType<typeof prepareStatements>;

/**
 * The engine's SQLite store (ARCHITECTURE.md 7.4, data-model.md): one writer
 * connection in WAL mode, an insert-only event log, a per-project head, and a
 * JSON projection per project. Writes go through `transaction`, which wraps
 * them in BEGIN IMMEDIATE and COMMIT so events, head, and projection land
 * together or not at all.
 */
export class Storage implements StorageReads {
  readonly #db: Database;
  readonly #now: () => Date;
  readonly #stmt: Statements;
  #pairings: SqlitePairingRecords | undefined;

  constructor(db: Database, now: () => Date) {
    this.#db = db;
    this.#now = now;
    this.#stmt = prepareStatements(db);
  }

  /** The SQLite journal mode; "wal" once opened. */
  journalMode(): string {
    return String(this.#db.prepare("PRAGMA journal_mode").get()?.journal_mode);
  }

  foreignKeys(): boolean {
    return this.#db.prepare("PRAGMA foreign_keys").get()?.foreign_keys === 1;
  }

  schemaVersion(): number {
    return currentSchemaVersion(this.#db);
  }

  project(id: string): ProjectRecord | undefined {
    const row = this.#stmt.project.get(id) as ProjectRow | undefined;
    return row && toProject(row);
  }

  projects(): ProjectRecord[] {
    return (this.#stmt.projects.all() as unknown as ProjectRow[]).map(toProject);
  }

  head(projectId: string): number | undefined {
    const row = this.#stmt.head.get(projectId) as { head: number } | undefined;
    return row?.head;
  }

  projection<S = unknown>(projectId: string): ProjectionRecord<S> | undefined {
    const row = this.#stmt.projection.get(projectId) as ProjectionRow | undefined;
    if (!row) return undefined;
    return {
      projectId: row.project_id,
      reducerVersion: row.reducer_version,
      head: row.head,
      stateHash: row.state_hash,
      state: JSON.parse(row.state_json) as S,
    };
  }

  projectionMeta(projectId: string): ProjectionMeta | undefined {
    const row = this.#stmt.projectionMeta.get(projectId) as
      | { reducer_version: number; head: number; state_hash: string }
      | undefined;
    if (!row) return undefined;
    return { reducerVersion: row.reducer_version, head: row.head, stateHash: row.state_hash };
  }

  /** Reads back one of the memory and WAL pragmas. */
  pragma(name: StoragePragma): number {
    return Number(this.#db.prepare(`PRAGMA ${name}`).get()?.[name]);
  }

  findEventBySourceKey(
    projectId: string,
    sourceId: string,
    sourceEventId: string,
  ): StoredEventRecord | undefined {
    const row = this.#stmt.bySourceKey.get(projectId, sourceId, sourceEventId) as
      | { event_id: string; ingest_sequence: number; content_hash: string; envelope_json: string }
      | undefined;
    if (!row) return undefined;
    return {
      eventId: row.event_id,
      ingestSequence: row.ingest_sequence,
      contentHash: row.content_hash,
      envelope: JSON.parse(row.envelope_json) as StoredEnvelope,
    };
  }

  *events(projectId: string, afterSequence = 0): IterableIterator<StoredEnvelope> {
    const rows = this.#stmt.events.iterate(projectId, afterSequence) as Iterable<{
      envelope_json: string;
    }>;
    for (const row of rows) yield JSON.parse(row.envelope_json) as StoredEnvelope;
  }

  /**
   * Runs `fn` inside BEGIN IMMEDIATE ... COMMIT and returns its result. Any
   * throw rolls everything back. `fn` must be synchronous (a promise would let
   * other work interleave with the open transaction) and must not nest.
   */
  transaction<T>(fn: (tx: StorageTransaction) => T): T {
    if (this.#db.isTransaction) throw new StorageError("transactions cannot nest");
    let active = true;
    const live = () => {
      if (!active) throw new StorageError("transaction handle used after its transaction ended");
    };
    const tx: StorageTransaction = {
      project: (id) => this.project(id),
      projects: () => this.projects(),
      head: (projectId) => this.head(projectId),
      projection: (projectId) => this.projection(projectId),
      projectionMeta: (projectId) => this.projectionMeta(projectId),
      findEventBySourceKey: (p, s, e) => this.findEventBySourceKey(p, s, e),
      events: (projectId, after) => this.events(projectId, after),
      insertProject: (project) => {
        live();
        this.#insertProject(project);
      },
      appendEvent: (envelope, contentHash) => {
        live();
        this.#appendEvent(envelope, contentHash);
      },
      writeProjection: (projection) => {
        live();
        return this.#writeProjection(projection);
      },
    };
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn(tx);
      if (typeof (result as { then?: unknown } | undefined)?.then === "function") {
        // Swallow the abandoned promise's own rejection; the caller gets this error.
        Promise.resolve(result).catch(() => {});
        throw new StorageError("transaction callbacks must be synchronous");
      }
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    } finally {
      active = false;
    }
  }

  /** `PairingRecords` over the `pairings` table (digests only). Not wired into the engine by default; see decision #113. */
  pairingRecords(): PairingRecords {
    this.#pairings ??= new SqlitePairingRecords(this.#db, this.#now);
    return this.#pairings;
  }

  close(): void {
    this.#db.close();
  }

  #insertProject(project: NewProject): void {
    this.#stmt.insertProject.run(
      project.id,
      project.name,
      project.createdAt,
      JSON.stringify(project.roots),
      project.builtin ? 1 : 0,
    );
  }

  #appendEvent(envelope: StoredEnvelope, contentHash: string): void {
    if (!SHA256_HEX.test(contentHash)) {
      throw new StorageError("content hash must be 64 lowercase hex characters");
    }
    this.#stmt.appendEvent.run(
      envelope.projectId,
      envelope.ingestSequence,
      envelope.eventId,
      envelope.sourceId,
      envelope.sourceEventId,
      envelope.sourceSequence ?? null,
      envelope.occurredAt,
      envelope.receivedAt,
      envelope.type,
      envelope.schemaVersion,
      envelope.provenance,
      contentHash,
      canonicalJson(envelope),
    );
  }

  #writeProjection(projection: ProjectionWrite): string {
    const head = this.head(projection.projectId);
    if (head === undefined) throw new StorageError(`unknown project ${projection.projectId}`);
    if (projection.head !== head) {
      throw new StorageError(
        `projection head ${projection.head} does not match project head ${head}`,
      );
    }
    const version = projection.reducerVersion;
    if (!Number.isSafeInteger(version) || version < 0) {
      throw new RangeError("reducerVersion must be a non-negative safe integer");
    }
    // stateHash(version, state) is `<version>:<sha256 of canonicalJson(state)>`; serializing once
    // and hashing the stored text gives the same value without a second full serialization.
    const json = canonicalJson(projection.state);
    const hash = `${version}:${sha256Hex(json)}`;
    this.#stmt.writeProjection.run(projection.projectId, version, projection.head, hash, json);
    return hash;
  }
}

/**
 * Opens (creating if needed) the database at `path`: owner-only file modes,
 * WAL, `synchronous=NORMAL`, foreign keys on, defensive mode, then migrations.
 */
export function openStorage(path: string, options: StorageOptions = {}): Storage {
  const now = options.now ?? (() => new Date());
  secureDatabaseFiles(path);
  const db = new Database(path, {
    timeout: options.busyTimeoutMs ?? 5000,
    enableForeignKeyConstraints: true,
    defensive: true,
  });
  try {
    const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
    if (mode !== "wal")
      throw new StorageError(`could not enable WAL (journal_mode is ${String(mode)})`);
    db.exec("PRAGMA synchronous = NORMAL");
    db.exec(`PRAGMA cache_size = -${PAGE_CACHE_KIB}`);
    db.exec(`PRAGMA wal_autocheckpoint = ${WAL_AUTOCHECKPOINT_PAGES}`);
    db.exec(`PRAGMA journal_size_limit = ${JOURNAL_SIZE_LIMIT_BYTES}`);
    migrate(db, now().toISOString());
    return new Storage(db, now);
  } catch (error) {
    db.close();
    throw error;
  }
}
