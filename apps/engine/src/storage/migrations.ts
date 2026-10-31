import { StorageError } from "./errors.ts";
import type { Database } from "./sqlite.ts";

// Schema migrations, applied in order inside one BEGIN IMMEDIATE transaction.
// A migration is never edited after it ships; changes are new migrations.
// Requests, commands, checkpoints, archives, and settings tables arrive with
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

const MIGRATIONS: readonly string[] = [V1];

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
