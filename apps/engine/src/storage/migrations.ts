import { StorageError } from "./errors.ts";
import type { Database } from "./sqlite.ts";

// Schema migrations, applied in order inside one BEGIN IMMEDIATE transaction.
// A migration is never edited after it ships; changes are new migrations.
// Requests, commands, and settings tables arrive with
// the milestones that need them (data-model.md, decision #114).

const V1 = `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  created_at TEXT NOT NULL,
  roots_json TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0 CHECK (builtin IN (0, 1)),
  head INTEGER NOT NULL DEFAULT 0 CHECK (head >= 0)
) STRICT;

CREATE TRIGGER projects_builtin_no_delete BEFORE DELETE ON projects
WHEN OLD.builtin = 1
BEGIN SELECT RAISE(ABORT, 'builtin projects cannot be removed'); END;

CREATE TABLE events (
  project_id TEXT NOT NULL REFERENCES projects(id),
  ingest_sequence INTEGER NOT NULL CHECK (ingest_sequence >= 1),
  event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_sequence INTEGER,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('live', 'imported', 'demo')),
  content_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  PRIMARY KEY (project_id, ingest_sequence),
  UNIQUE (project_id, source_id, source_event_id)
) STRICT;

-- Insert-only (constitution II). These triggers hold for every connection,
-- not only the engine's statements. REPLACE conflict resolution deletes rows
-- without firing DELETE triggers unless recursive_triggers is on, so an insert
-- that would collide with an existing row is aborted before REPLACE can act.
CREATE TRIGGER events_no_update BEFORE UPDATE ON events
BEGIN SELECT RAISE(ABORT, 'events are insert-only'); END;

CREATE TRIGGER events_no_delete BEFORE DELETE ON events
BEGIN SELECT RAISE(ABORT, 'events are insert-only'); END;

-- One BEFORE INSERT trigger with ordered checks, since SQLite does not
-- document the firing order of separate triggers. Gap-free per-project
-- sequence: an event must be exactly head + 1, and inserting it advances the
-- head in the same statement.
CREATE TRIGGER events_insert_checks BEFORE INSERT ON events
BEGIN
  SELECT RAISE(ABORT, 'events are insert-only') WHERE EXISTS (
    SELECT 1 FROM events
    WHERE event_id = NEW.event_id
       OR (project_id = NEW.project_id AND ingest_sequence = NEW.ingest_sequence)
       OR (project_id = NEW.project_id AND source_id = NEW.source_id
           AND source_event_id = NEW.source_event_id)
  );
  SELECT RAISE(ABORT, 'ingest sequence must be the project head + 1')
  WHERE NEW.ingest_sequence IS NOT (SELECT head + 1 FROM projects WHERE id = NEW.project_id);
END;

CREATE TRIGGER events_advance_head AFTER INSERT ON events
BEGIN UPDATE projects SET head = NEW.ingest_sequence WHERE id = NEW.project_id; END;

-- The head only ever names the project's last event, so no write elsewhere
-- can open a gap or rewind the sequence.
CREATE TRIGGER projects_head_matches_log BEFORE UPDATE OF head ON projects
WHEN NEW.head IS NOT
  (SELECT coalesce(max(ingest_sequence), 0) FROM events WHERE project_id = NEW.id)
BEGIN SELECT RAISE(ABORT, 'project head must equal its last ingest sequence'); END;

CREATE TABLE projections (
  project_id TEXT PRIMARY KEY REFERENCES projects(id),
  reducer_version INTEGER NOT NULL,
  head INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  state_json TEXT NOT NULL
) STRICT;

CREATE TABLE pairings (
  id TEXT PRIMARY KEY,
  secret_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL,
  last_used_at TEXT
) STRICT;
`;

// Replay checkpoints (ARCHITECTURE.md 7.4): disposable caches of reducer state, tagged with the
// reducer version and the state hash. Additive; nothing else reads or depends on them.
const V2 = `
CREATE TABLE checkpoints (
  project_id TEXT NOT NULL REFERENCES projects(id),
  sequence INTEGER NOT NULL CHECK (sequence >= 1),
  reducer_version INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (project_id, sequence)
) STRICT;
`;

// Telemetry cost (M5.29): per-agent token and cost totals from the OTLP receiver, and the hashed
// identities of the data points already counted, so a re-delivered export is counted once. Both
// are bounded by the receiver (agents and remembered identities are capped). Not event-log data.
const V3 = `
CREATE TABLE otlp_cost (
  agent_id TEXT PRIMARY KEY CHECK (length(agent_id) <= 1024),
  parent_agent_id TEXT CHECK (parent_agent_id IS NULL OR length(parent_agent_id) <= 256),
  m_seen INTEGER NOT NULL CHECK (m_seen IN (0, 1)),
  m_seen_tokens INTEGER NOT NULL CHECK (m_seen_tokens IN (0, 1)),
  m_seen_cost INTEGER NOT NULL CHECK (m_seen_cost IN (0, 1)),
  m_input REAL NOT NULL CHECK (m_input >= 0),
  m_output REAL NOT NULL CHECK (m_output >= 0),
  m_cache_read REAL NOT NULL CHECK (m_cache_read >= 0),
  m_cache_creation REAL NOT NULL CHECK (m_cache_creation >= 0),
  m_cost_usd REAL NOT NULL CHECK (m_cost_usd >= 0),
  l_seen INTEGER NOT NULL CHECK (l_seen IN (0, 1)),
  l_input REAL NOT NULL CHECK (l_input >= 0),
  l_output REAL NOT NULL CHECK (l_output >= 0),
  l_cache_read REAL NOT NULL CHECK (l_cache_read >= 0),
  l_cache_creation REAL NOT NULL CHECK (l_cache_creation >= 0),
  l_cost_usd REAL NOT NULL CHECK (l_cost_usd >= 0),
  last_seen INTEGER NOT NULL
) STRICT;

CREATE INDEX otlp_cost_last_seen ON otlp_cost (last_seen);

CREATE TABLE otlp_seen (
  id INTEGER PRIMARY KEY,
  digest TEXT NOT NULL UNIQUE CHECK (length(digest) = 64)
) STRICT;
`;

// Archive timelines (M8.06): each import is its own read-only timeline, apart from the live log.
// Positions are 1..n per archive; `occurred_ms` is the instant of `occurred_at` (which keeps the
// source's offset), so "at or before" compares by the clock. Archive events are not live events:
// nothing here touches `events`, a project head, or a projection.
const V4 = `
CREATE TABLE archives (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  kind TEXT NOT NULL CHECK (kind IN ('git', 'transcripts')),
  label TEXT NOT NULL,
  root TEXT NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('running', 'done', 'failed', 'cancelled')),
  created_at TEXT NOT NULL,
  finished_at TEXT,
  counts_json TEXT NOT NULL,
  error TEXT,
  event_count INTEGER NOT NULL DEFAULT 0 CHECK (event_count >= 0),
  first_at TEXT,
  last_at TEXT
) STRICT;

CREATE INDEX archives_project ON archives (project_id, status, created_at);

CREATE TABLE archive_events (
  archive_id TEXT NOT NULL REFERENCES archives(id),
  position INTEGER NOT NULL CHECK (position >= 1),
  event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_sequence INTEGER,
  occurred_at TEXT NOT NULL,
  occurred_ms INTEGER NOT NULL,
  type TEXT NOT NULL,
  content_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  PRIMARY KEY (archive_id, position),
  UNIQUE (archive_id, source_id, source_event_id)
) STRICT;

CREATE INDEX archive_events_time ON archive_events (archive_id, occurred_ms);
`;

// Archive checkpoints (M8.09): disposable caches of reducer state at every 1,000th position of an
// archive, so a seek reduces at most 999 events. Keyed on the archive, never on the live
// `(project_id, sequence)` of `checkpoints`; deleted with their archive. IF NOT EXISTS because
// the migration tests rebuild an older schema by dropping only the tables they know of.
const V5 = `
CREATE TABLE IF NOT EXISTS archive_checkpoints (
  archive_id TEXT NOT NULL REFERENCES archives(id),
  position INTEGER NOT NULL CHECK (position >= 1),
  reducer_version INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  state_json TEXT NOT NULL,
  PRIMARY KEY (archive_id, position)
) STRICT;
`;

const MIGRATIONS: readonly string[] = [V1, V2, V3, V4, V5];

export const LATEST_SCHEMA_VERSION = MIGRATIONS.length;

/** The highest applied migration, or 0 for a new database. */
export function currentSchemaVersion(db: Database): number {
  const row = db.prepare("SELECT coalesce(max(version), 0) AS v FROM schema_migrations").get();
  return Number(row?.v ?? 0);
}

/**
 * Applies every pending migration in one transaction. Idempotent: an
 * up-to-date database is left untouched. Refuses a database written by a newer
 * schema, since this code cannot know what that schema guarantees.
 */
export function migrate(db: Database, appliedAt: string): number {
  db.exec("BEGIN IMMEDIATE");
  try {
    db.exec(
      "CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL) STRICT",
    );
    const current = currentSchemaVersion(db);
    if (current > LATEST_SCHEMA_VERSION) {
      throw new StorageError(
        `database schema version ${current} is newer than this engine supports (${LATEST_SCHEMA_VERSION})`,
      );
    }
    const record = db.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)");
    for (let version = current + 1; version <= LATEST_SCHEMA_VERSION; version++) {
      db.exec(MIGRATIONS[version - 1] as string);
      record.run(version, appliedAt);
    }
    db.exec("COMMIT");
    return LATEST_SCHEMA_VERSION;
  } catch (error) {
    if (db.isTransaction) db.exec("ROLLBACK");
    throw error;
  }
}
