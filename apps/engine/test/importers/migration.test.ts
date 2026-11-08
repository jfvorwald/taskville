import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, openStorage } from "../../src/storage/index.ts";
import { useImportsEnv } from "./helpers.ts";

// The archives migration (M8.06): applies to a database created at the previous schema version
// (3, the last one before archives) without touching existing data, and adds `archives` and
// `archive_events` as the design note (imports-design.md, Storage) lists them.

const env = useImportsEnv();
const PREVIOUS_VERSION = 3;

function columns(db: DatabaseSync, table: string): string[] {
  return db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .map((row) => String(row.name));
}

describe("archives migration", () => {
  it("applies to a database at the previous schema version and keeps its data", () => {
    const { storage, dbPath } = env();
    const headBefore = storage.head("demo");
    const eventsBefore = [...storage.events("demo")];
    storage.close();

    // Turn the freshly migrated database into one that was last opened at version 3.
    const raw = new DatabaseSync(dbPath);
    raw.exec("DROP TABLE IF EXISTS archive_events");
    raw.exec("DROP TABLE IF EXISTS archives");
    raw.prepare("DELETE FROM schema_migrations WHERE version > ?").run(PREVIOUS_VERSION);
    raw.close();

    const reopened = openStorage(dbPath);
    try {
      expect(LATEST_SCHEMA_VERSION).toBeGreaterThan(PREVIOUS_VERSION);
      expect(reopened.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
      expect(reopened.head("demo")).toBe(headBefore);
      expect([...reopened.events("demo")]).toEqual(eventsBefore);
    } finally {
      reopened.close();
    }

    const check = new DatabaseSync(dbPath);
    try {
      const tables = check
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name));
      expect(tables).toEqual(expect.arrayContaining(["archives", "archive_events"]));
      expect(columns(check, "archives")).toEqual(
        expect.arrayContaining([
          "id",
          "project_id",
          "kind",
          "label",
          "root",
          "status",
          "created_at",
          "finished_at",
          "counts_json",
          "error",
          "event_count",
          "first_at",
          "last_at",
        ]),
      );
      expect(columns(check, "archive_events")).toEqual(
        expect.arrayContaining([
          "archive_id",
          "position",
          "event_id",
          "source_id",
          "source_event_id",
          "source_sequence",
          "occurred_at",
          "type",
          "content_hash",
          "envelope_json",
        ]),
      );
      const versions = check
        .prepare("SELECT version FROM schema_migrations ORDER BY version")
        .all()
        .map((row) => Number(row.version));
      expect(versions).toEqual(Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1));
    } finally {
      check.close();
    }
  });

  it("is idempotent across reopen", () => {
    const { storage, dbPath } = env();
    storage.close();
    openStorage(dbPath).close();
    const again = openStorage(dbPath);
    try {
      expect(again.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
      expect(again.archives().listDone("demo")).toEqual([]);
    } finally {
      again.close();
    }
  });
});
