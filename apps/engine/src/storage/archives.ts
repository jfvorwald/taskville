import type { StoredEnvelope } from "@taskville/protocol";
import { StorageError } from "./errors.ts";
import type { Database, Statement } from "./sqlite.ts";

// Archive timelines (ARCHITECTURE.md 7.3, 7.4; docs/superpowers/specs/2026-11-08-imports-design.md):
// each import is its own read-only timeline in `archives` and `archive_events`, apart from the
// live event log. An archive is written once, in one transaction, and is immutable after that.

export type ArchiveKind = "git" | "transcripts";
export type ArchiveStatus = "running" | "done" | "failed" | "cancelled";

/** Import totals. Never contain source text. */
export interface ArchiveCounts {
  read: number;
  imported: number;
  skipped: number;
  malformed: number;
  /** Rejections by protocol code among the events the job runner refused. */
  malformedByCode?: Record<string, number>;
  /** True when the event cap stopped the import; the rest is counted as skipped. */
  truncated?: boolean;
  /** Evidence items dropped by a size limit, the budget, or because no kept event refers to them. */
  evidenceDropped?: number;
}

/** A failure code and a short message, never source text. */
export interface ArchiveError {
  code: string;
  message: string;
}

export interface ArchiveRecord {
  id: string;
  projectId: string;
  kind: ArchiveKind;
  label: string;
  root: string;
  status: ArchiveStatus;
  createdAt: string;
  finishedAt: string | null;
  counts: ArchiveCounts;
  error: ArchiveError | null;
  eventCount: number;
  firstAt: string | null;
  lastAt: string | null;
}

export interface NewArchive {
  id: string;
  projectId: string;
  kind: ArchiveKind;
  label: string;
  root: string;
  createdAt: string;
}

/** One event of an archive. `envelope.ingestSequence` is its position, 1..n in the order given. */
export interface ArchiveEventWrite {
  contentHash: string;
  envelope: StoredEnvelope;
}

const SHA256_HEX = /^[0-9a-f]{64}$/;
const ZERO_COUNTS: ArchiveCounts = { read: 0, imported: 0, skipped: 0, malformed: 0 };

interface ArchiveRow {
  id: string;
  project_id: string;
  kind: ArchiveKind;
  label: string;
  root: string;
  status: ArchiveStatus;
  created_at: string;
  finished_at: string | null;
  counts_json: string;
  error: string | null;
  event_count: number;
  first_at: string | null;
  last_at: string | null;
}

function toArchive(row: ArchiveRow): ArchiveRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    kind: row.kind,
    label: row.label,
    root: row.root,
    status: row.status,
    createdAt: row.created_at,
    finishedAt: row.finished_at,
    counts: JSON.parse(row.counts_json) as ArchiveCounts,
    error: row.error === null ? null : (JSON.parse(row.error) as ArchiveError),
    eventCount: row.event_count,
    firstAt: row.first_at,
    lastAt: row.last_at,
  };
}

/** The instant of a timestamp with an offset, so `+02:00` and `Z` compare by the clock. */
function instantMs(text: string): number {
  const ms = Date.parse(text);
  if (Number.isNaN(ms)) throw new StorageError("occurredAt is not a timestamp");
  return ms;
}

/** Archives and their events (`archives`, `archive_events`). */
export class SqliteArchives {
  readonly #db: Database;
  readonly #insert: Statement;
  readonly #get: Statement;
  readonly #running: Statement;
  readonly #listDone: Statement;
  readonly #listDoneFor: Statement;
  readonly #deleteEvents: Statement;
  readonly #deleteArchive: Statement;
  readonly #finish: Statement;
  readonly #interrupt: Statement;
  readonly #updateCounts: Statement;
  readonly #insertEvent: Statement;
  readonly #events: Statement;
  readonly #eventAt: Statement;
  readonly #positionAtOrBefore: Statement;

  constructor(db: Database) {
    this.#db = db;
    this.#insert = db.prepare(
      `INSERT INTO archives (id, project_id, kind, label, root, status, created_at, counts_json)
       VALUES (?, ?, ?, ?, ?, 'running', ?, ?)`,
    );
    this.#get = db.prepare("SELECT * FROM archives WHERE id = ?");
    this.#running = db.prepare(
      "SELECT * FROM archives WHERE project_id = ? AND status = 'running' LIMIT 1",
    );
    this.#listDone = db.prepare(
      `SELECT * FROM archives WHERE project_id = ? AND status = 'done'
       ORDER BY created_at DESC, rowid DESC`,
    );
    this.#listDoneFor = db.prepare(
      `SELECT id FROM archives WHERE project_id = ? AND kind = ? AND root = ? AND status = 'done'
       ORDER BY created_at DESC, rowid DESC`,
    );
    this.#deleteEvents = db.prepare("DELETE FROM archive_events WHERE archive_id = ?");
    this.#deleteArchive = db.prepare("DELETE FROM archives WHERE id = ?");
    this.#finish = db.prepare(
      `UPDATE archives SET status = ?, finished_at = ?, counts_json = ?, error = ?,
         event_count = ?, first_at = ?, last_at = ?
       WHERE id = ? AND status = 'running'`,
    );
    this.#interrupt = db.prepare(
      `UPDATE archives SET status = 'failed', finished_at = ?, error = ? WHERE status = 'running'`,
    );
    this.#updateCounts = db.prepare(
      "UPDATE archives SET counts_json = ? WHERE id = ? AND status = 'done'",
    );
    this.#insertEvent = db.prepare(
      `INSERT INTO archive_events (archive_id, position, event_id, source_id, source_event_id,
         source_sequence, occurred_at, occurred_ms, type, content_hash, envelope_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    this.#events = db.prepare(
      `SELECT envelope_json FROM archive_events WHERE archive_id = ? AND position BETWEEN ? AND ?
       ORDER BY position`,
    );
    this.#eventAt = db.prepare(
      "SELECT envelope_json FROM archive_events WHERE archive_id = ? AND position = ?",
    );
    this.#positionAtOrBefore = db.prepare(
      `SELECT coalesce(max(position), 0) AS position FROM archive_events
       WHERE archive_id = ? AND occurred_ms <= ?`,
    );
  }

  /** Records a new archive as `running`. Fails for an unknown project. */
  create(archive: NewArchive): ArchiveRecord {
    this.#insert.run(
      archive.id,
      archive.projectId,
      archive.kind,
      archive.label,
      archive.root,
      archive.createdAt,
      JSON.stringify(ZERO_COUNTS),
    );
    return this.#require(archive.id);
  }

  get(id: string): ArchiveRecord | undefined {
    const row = this.#get.get(id) as ArchiveRow | undefined;
    return row && toArchive(row);
  }

  /** The project's running archive, if any. */
  running(projectId: string): ArchiveRecord | undefined {
    const row = this.#running.get(projectId) as ArchiveRow | undefined;
    return row && toArchive(row);
  }

  /** The project's finished archives (`done` only), newest first. */
  listDone(projectId: string): ArchiveRecord[] {
    return (this.#listDone.all(projectId) as unknown as ArchiveRow[]).map(toArchive);
  }

  /** IDs of the done archives of one project, kind and root, newest first. */
  listDoneIds(projectId: string, kind: ArchiveKind, root: string): string[] {
    return (this.#listDoneFor.all(projectId, kind, root) as unknown as { id: string }[]).map(
      (row) => row.id,
    );
  }

  /** Deletes an archive and its events. */
  delete(id: string): void {
    this.#transaction(() => {
      this.#deleteEvents.run(id);
      this.#deleteArchive.run(id);
    });
  }

  /**
   * Writes every event and marks the archive `done` in one transaction. Positions must be 1..n in
   * the order given. Any failure leaves the archive `running` and empty.
   */
  complete(
    id: string,
    write: { events: readonly ArchiveEventWrite[]; counts: ArchiveCounts; finishedAt: string },
  ): ArchiveRecord {
    const events = write.events;
    this.#transaction(() => {
      const archive = this.#require(id);
      if (archive.status !== "running") throw new StorageError(`archive ${id} is already finished`);
      events.forEach((event, index) => {
        const { envelope, contentHash } = event;
        if (!SHA256_HEX.test(contentHash)) {
          throw new StorageError("content hash must be 64 lowercase hex characters");
        }
        if (envelope.ingestSequence !== index + 1) {
          throw new StorageError("archive positions must be 1..n in order");
        }
        if (envelope.projectId !== archive.projectId) {
          throw new StorageError("archive events must belong to the archive's project");
        }
        this.#insertEvent.run(
          id,
          envelope.ingestSequence,
          envelope.eventId,
          envelope.sourceId,
          envelope.sourceEventId,
          envelope.sourceSequence ?? null,
          envelope.occurredAt,
          instantMs(envelope.occurredAt),
          envelope.type,
          contentHash,
          JSON.stringify(envelope),
        );
      });
      this.#finishRow(id, "done", write.finishedAt, write.counts, null, {
        eventCount: events.length,
        firstAt: events[0]?.envelope.occurredAt ?? null,
        lastAt: events[events.length - 1]?.envelope.occurredAt ?? null,
      });
    });
    return this.#require(id);
  }

  /** Replaces the counts of a done archive (what is only known after its events were written). */
  updateCounts(id: string, counts: ArchiveCounts): void {
    const result = this.#updateCounts.run(JSON.stringify(counts), id);
    if (Number(result.changes) === 0) throw new StorageError(`archive ${id} is not done`);
  }

  /** Marks a running archive `failed`. It keeps no events. */
  fail(
    id: string,
    result: { error: ArchiveError; counts: ArchiveCounts; finishedAt: string },
  ): ArchiveRecord {
    this.#finishRow(id, "failed", result.finishedAt, result.counts, result.error);
    return this.#require(id);
  }

  /** Marks a running archive `cancelled`. It keeps no events. */
  cancel(id: string, result: { counts: ArchiveCounts; finishedAt: string }): ArchiveRecord {
    this.#finishRow(id, "cancelled", result.finishedAt, result.counts, null);
    return this.#require(id);
  }

  /** Fails every archive still `running` (its engine died); returns how many. */
  failInterrupted(finishedAt: string): number {
    const error: ArchiveError = {
      code: "interrupted",
      message: "The engine stopped before the import finished",
    };
    return Number(this.#interrupt.run(finishedAt, JSON.stringify(error)).changes);
  }

  /** The archive's events at positions `from` to `to`, inclusive, in position order. */
  events(id: string, from: number, to: number): StoredEnvelope[] {
    return (this.#events.all(id, from, to) as unknown as { envelope_json: string }[]).map(
      (row) => JSON.parse(row.envelope_json) as StoredEnvelope,
    );
  }

  eventAt(id: string, position: number): StoredEnvelope | undefined {
    const row = this.#eventAt.get(id, position) as { envelope_json: string } | undefined;
    return row && (JSON.parse(row.envelope_json) as StoredEnvelope);
  }

  /** The greatest position whose occurredAt is at or before `at` (by instant), 0 if none. */
  positionAtOrBefore(id: string, at: string): number {
    const row = this.#positionAtOrBefore.get(id, instantMs(at)) as { position: number };
    return Number(row.position);
  }

  #finishRow(
    id: string,
    status: ArchiveStatus,
    finishedAt: string,
    counts: ArchiveCounts,
    error: ArchiveError | null,
    summary: { eventCount: number; firstAt: string | null; lastAt: string | null } = {
      eventCount: 0,
      firstAt: null,
      lastAt: null,
    },
  ): void {
    const result = this.#finish.run(
      status,
      finishedAt,
      JSON.stringify(counts),
      error === null ? null : JSON.stringify(error),
      summary.eventCount,
      summary.firstAt,
      summary.lastAt,
      id,
    );
    if (Number(result.changes) === 0) {
      throw new StorageError(`archive ${id} is not running`);
    }
  }

  #require(id: string): ArchiveRecord {
    const archive = this.get(id);
    if (!archive) throw new StorageError(`unknown archive ${id}`);
    return archive;
  }

  #transaction(work: () => void): void {
    if (this.#db.isTransaction) throw new StorageError("transactions cannot nest");
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      work();
      this.#db.exec("COMMIT");
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
