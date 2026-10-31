import { redactText } from "@taskville/adapters/redact";
import { ID_MAX_LENGTH } from "@taskville/protocol";
import type { Logger } from "pino";
import type { EvidenceSink, HookEvidence } from "../sources/claude-code/index.ts";
import { StorageError } from "../storage/errors.ts";
import { secureDatabaseFiles } from "../storage/file-mode.ts";
import { Database } from "../storage/sqlite.ts";
import { type PreparedBody, prepareBody } from "./body.ts";

/** ARCHITECTURE.md 7.4: per-project evidence cap, default 1 GB. */
export const DEFAULT_CAP_BYTES = 1024 ** 3;
/** What the code feed shows for a tool call whose body was evicted. */
export const EVICTED_MESSAGE = "details no longer stored";

const SCHEMA_VERSION = 1;
// C0 controls and DEL never appear in a tool call ID.
// biome-ignore lint/suspicious/noControlCharactersInRegex: the point is to find them
const CONTROL = /[\u0000-\u001f\u007f]/;
const EVICT_BATCH = 64;

export type BodyPart = "input" | "output";

export type EvidenceBody =
  | {
      status: "stored";
      hash: string;
      text: string;
      bytes: number;
      truncated: boolean;
      masked: boolean;
    }
  | { status: "evicted"; hash: string; message: typeof EVICTED_MESSAGE };

/** A ToolCall's bodies (M5.01 reads this): `null` for a part never stored. */
export interface ToolCallEvidence {
  toolCallId: string;
  input: EvidenceBody | null;
  output: EvidenceBody | null;
}

export interface EvidenceStoreOptions {
  /** Per-project cap on stored body bytes. Default 1 GB. */
  capBytes?: number;
  busyTimeoutMs?: number;
  now?: () => Date;
  logger?: Logger;
}

interface BodyRow {
  hash: string;
  body: string | null;
  bytes: number | null;
  truncated: number | null;
  masked: number | null;
}

/**
 * The evidence store (ARCHITECTURE.md 7.4, revision 3): tool call bodies in a
 * separate SQLite database, `evidence.db`, apart from the event log.
 *
 * - `bodies` is content-addressed per project: `(project_id, hash)`, where the
 *   hash is SHA-256 of the stored, redacted bytes. Nothing raw is ever written
 *   (`prepareBody` masks before anything reaches SQLite), and nothing stored
 *   is derived from the raw bytes.
 * - `tool_call_bodies` is the ToolCall pointer, `(project_id, tool_call_id,
 *   part)` to a hash. Pointers are never evicted, so an evicted body still
 *   shows that the call happened ("details no longer stored"). The first body
 *   for a part wins, like the event log's first write.
 * - `usage` keeps each project's stored bytes, so the cap check is one row.
 *   Over the cap, the least recently written bodies of that project go first
 *   (writing or re-referencing a body makes it the newest), never the body
 *   just written. Eviction and project deletion are plain DELETEs.
 *
 * One engine process per file: `last_used` ticks come from this process.
 */
export class EvidenceStore implements EvidenceSink {
  readonly capBytes: number;
  readonly #db: Database;
  readonly #now: () => Date;
  readonly #logger: Logger | undefined;
  #tick: number;

  constructor(db: Database, options: EvidenceStoreOptions) {
    this.#db = db;
    this.capBytes = options.capBytes ?? DEFAULT_CAP_BYTES;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
    const row = db.prepare("SELECT COALESCE(MAX(last_used), 0) AS tick FROM bodies").get();
    this.#tick = Number(row?.tick ?? 0);
  }

  journalMode(): string {
    return String(this.#db.prepare("PRAGMA journal_mode").get()?.journal_mode);
  }

  /** The `EvidenceSink` the Claude Code source calls after its events commit. */
  store(projectId: string, evidence: readonly HookEvidence[]): void {
    const writes: { toolCallId: string; part: BodyPart; body: PreparedBody }[] = [];
    for (const item of evidence) {
      if (!isToolCallId(item.toolCallId)) continue;
      for (const part of ["input", "output"] as const) {
        const value = item[part];
        if (value === undefined) continue;
        const body = this.#prepare(value);
        if (body !== undefined) writes.push({ toolCallId: item.toolCallId, part, body });
      }
    }
    if (writes.length === 0) return;
    this.#transaction(() => {
      for (const write of writes) this.#write(projectId, write.toolCallId, write.part, write.body);
    });
  }

  /** A tool call's bodies, or undefined when nothing was ever stored for it. */
  get(projectId: string, toolCallId: string): ToolCallEvidence | undefined {
    const rows = this.#db
      .prepare(
        `SELECT p.part AS part, p.hash AS hash, b.body AS body, b.bytes AS bytes,
                b.truncated AS truncated, b.masked AS masked
           FROM tool_call_bodies p
           LEFT JOIN bodies b ON b.project_id = p.project_id AND b.hash = p.hash
          WHERE p.project_id = ? AND p.tool_call_id = ?`,
      )
      .all(projectId, toolCallId) as unknown as (BodyRow & { part: BodyPart })[];
    if (rows.length === 0) return undefined;
    const result: ToolCallEvidence = { toolCallId, input: null, output: null };
    for (const row of rows) result[row.part] = toBody(row);
    return result;
  }

  /** Stored bodies and bytes of a project. */
  stats(projectId: string): { bodies: number; bytes: number } {
    const row = this.#db
      .prepare("SELECT bodies, bytes FROM usage WHERE project_id = ?")
      .get(projectId);
    return { bodies: Number(row?.bodies ?? 0), bytes: Number(row?.bytes ?? 0) };
  }

  /** Removes every body and pointer of a project. */
  deleteProject(projectId: string): void {
    this.#transaction(() => {
      for (const table of ["tool_call_bodies", "bodies", "usage"]) {
        this.#db.prepare(`DELETE FROM ${table} WHERE project_id = ?`).run(projectId);
      }
    });
  }

  close(): void {
    if (this.#db.isOpen) this.#db.close();
  }

  #prepare(value: unknown): PreparedBody | undefined {
    try {
      return prepareBody(value);
    } catch (error) {
      // Name only: the message can carry the body.
      this.#logger?.warn({ errName: (error as Error).name }, "evidence body not stored");
      return undefined;
    }
  }

  #write(projectId: string, toolCallId: string, part: BodyPart, body: PreparedBody): void {
    const db = this.#db;
    const pointer = db
      .prepare(
        "SELECT 1 AS found FROM tool_call_bodies WHERE project_id = ? AND tool_call_id = ? AND part = ?",
      )
      .get(projectId, toolCallId, part);
    if (pointer !== undefined) return;
    db.prepare(
      "INSERT INTO tool_call_bodies (project_id, tool_call_id, part, hash, stored_at) VALUES (?, ?, ?, ?, ?)",
    ).run(projectId, toolCallId, part, body.hash, this.#now().toISOString());

    const tick = ++this.#tick;
    const known = db
      .prepare("UPDATE bodies SET last_used = ? WHERE project_id = ? AND hash = ?")
      .run(tick, projectId, body.hash);
    if (Number(known.changes) > 0) return;
    db.prepare(
      `INSERT INTO bodies (project_id, hash, body, bytes, truncated, masked, last_used)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      projectId,
      body.hash,
      body.text,
      body.bytes,
      body.truncated ? 1 : 0,
      body.masked ? 1 : 0,
      tick,
    );
    db.prepare(
      `INSERT INTO usage (project_id, bodies, bytes) VALUES (?, 1, ?)
       ON CONFLICT (project_id) DO UPDATE SET bodies = bodies + 1, bytes = bytes + excluded.bytes`,
    ).run(projectId, body.bytes);
    this.#evict(projectId, body.hash);
  }

  /** Oldest first until the project is within its cap, sparing `keep` (the body just written). */
  #evict(projectId: string, keep: string): void {
    const db = this.#db;
    const oldest = db.prepare(
      `SELECT hash, bytes FROM bodies WHERE project_id = ? AND hash <> ?
        ORDER BY last_used LIMIT ${EVICT_BATCH}`,
    );
    const remove = db.prepare("DELETE FROM bodies WHERE project_id = ? AND hash = ?");
    const debit = db.prepare(
      "UPDATE usage SET bodies = bodies - 1, bytes = bytes - ? WHERE project_id = ?",
    );
    let used = this.stats(projectId).bytes;
    while (used > this.capBytes) {
      const victims = oldest.all(projectId, keep) as unknown as { hash: string; bytes: number }[];
      if (victims.length === 0) return;
      for (const victim of victims) {
        if (used <= this.capBytes) return;
        remove.run(projectId, victim.hash);
        debit.run(victim.bytes, projectId);
        used -= Number(victim.bytes);
      }
    }
  }

  #transaction(fn: () => void): void {
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      fn();
      this.#db.exec("COMMIT");
    } catch (error) {
      this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}

function toBody(row: BodyRow): EvidenceBody {
  if (row.body === null) return { status: "evicted", hash: row.hash, message: EVICTED_MESSAGE };
  return {
    status: "stored",
    hash: row.hash,
    text: row.body,
    bytes: Number(row.bytes),
    truncated: row.truncated === 1,
    masked: row.masked === 1,
  };
}

/** A tool call ID is stored unmasked, so it must be a plain ID the redactor leaves alone. */
function isToolCallId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= ID_MAX_LENGTH &&
    value.isWellFormed() &&
    !CONTROL.test(value) &&
    redactText(value).spans.length === 0
  );
}

/**
 * Opens (creating if needed) `evidence.db` at `path`: the file and any WAL
 * and SHM files owner-only before SQLite touches them (L-23), symlinks
 * refused, WAL, `synchronous=NORMAL`, defensive mode, then the schema.
 */
export function openEvidenceStore(path: string, options: EvidenceStoreOptions = {}): EvidenceStore {
  const cap = options.capBytes ?? DEFAULT_CAP_BYTES;
  if (!Number.isSafeInteger(cap) || cap < 1) {
    throw new RangeError("capBytes must be a positive whole number of bytes");
  }
  secureDatabaseFiles(path);
  const db = new Database(path, { timeout: options.busyTimeoutMs ?? 5000, defensive: true });
  try {
    const mode = db.prepare("PRAGMA journal_mode = WAL").get()?.journal_mode;
    if (mode !== "wal") {
      throw new StorageError(
        `could not enable WAL on evidence.db (journal_mode is ${String(mode)})`,
      );
    }
    db.exec("PRAGMA synchronous = NORMAL");
    const version = Number(db.prepare("PRAGMA user_version").get()?.user_version ?? 0);
    if (version > SCHEMA_VERSION) {
      throw new StorageError(
        `evidence.db schema ${version} is newer than this engine (${SCHEMA_VERSION})`,
      );
    }
    if (version < SCHEMA_VERSION) {
      db.exec(`
        BEGIN IMMEDIATE;
        CREATE TABLE bodies (
          project_id TEXT NOT NULL,
          hash TEXT NOT NULL CHECK (length(hash) = 64),
          body TEXT NOT NULL,
          bytes INTEGER NOT NULL CHECK (bytes >= 0),
          truncated INTEGER NOT NULL CHECK (truncated IN (0, 1)),
          masked INTEGER NOT NULL CHECK (masked IN (0, 1)),
          last_used INTEGER NOT NULL,
          PRIMARY KEY (project_id, hash)
        ) WITHOUT ROWID;
        CREATE INDEX bodies_by_age ON bodies (project_id, last_used);
        CREATE TABLE tool_call_bodies (
          project_id TEXT NOT NULL,
          tool_call_id TEXT NOT NULL,
          part TEXT NOT NULL CHECK (part IN ('input', 'output')),
          hash TEXT NOT NULL,
          stored_at TEXT NOT NULL,
          PRIMARY KEY (project_id, tool_call_id, part)
        ) WITHOUT ROWID;
        CREATE TABLE usage (
          project_id TEXT PRIMARY KEY,
          bodies INTEGER NOT NULL,
          bytes INTEGER NOT NULL
        ) WITHOUT ROWID;
        PRAGMA user_version = ${SCHEMA_VERSION};
        COMMIT;
      `);
    }
    return new EvidenceStore(db, { ...options, capBytes: cap });
  } catch (error) {
    db.close();
    throw error;
  }
}
