import { chmodSync, existsSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import {
  LATEST_SCHEMA_VERSION,
  openStorage,
  StorageError,
  UNSORTED_PROJECT_ID,
} from "../../src/storage/index.ts";
import { envelope, HASH_A, useTempDir } from "./helpers.ts";

const dir = useTempDir();

function schemaSnapshot(path: string): unknown[] {
  const raw = new DatabaseSync(path);
  try {
    return raw.prepare("SELECT type, name, sql FROM sqlite_master ORDER BY type, name").all();
  } finally {
    raw.close();
  }
}

describe("openStorage", () => {
  it("opens the database in WAL mode with foreign keys on", () => {
    const storage = openStorage(join(dir(), "taskville.db"));
    try {
      expect(storage.journalMode()).toBe("wal");
      expect(storage.foreignKeys()).toBe(true);
    } finally {
      storage.close();
    }
  });

  it("creates every table the data model lists for M1, and no request or command tables", () => {
    const path = join(dir(), "taskville.db");
    openStorage(path).close();
    const tables = schemaSnapshot(path)
      .filter((row) => (row as { type: string }).type === "table")
      .map((row) => (row as { name: string }).name);
    expect(tables).toEqual(
      expect.arrayContaining([
        "schema_migrations",
        "projects",
        "events",
        "projections",
        "pairings",
      ]),
    );
    expect(tables).not.toContain("pending_requests");
    expect(tables).not.toContain("commands");
  });

  it("records each migration once and is idempotent across reopen", () => {
    const path = join(dir(), "taskville.db");
    const first = openStorage(path);
    expect(first.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    first.close();
    const before = schemaSnapshot(path);

    const second = openStorage(path);
    expect(second.schemaVersion()).toBe(LATEST_SCHEMA_VERSION);
    second.close();
    openStorage(path).close();

    expect(schemaSnapshot(path)).toEqual(before);
    const raw = new DatabaseSync(path);
    try {
      const versions = raw.prepare("SELECT version FROM schema_migrations ORDER BY version").all();
      expect(versions.map((row) => row.version)).toEqual(
        Array.from({ length: LATEST_SCHEMA_VERSION }, (_, i) => i + 1),
      );
    } finally {
      raw.close();
    }
  });

  it("keeps data across reopen", () => {
    const path = join(dir(), "taskville.db");
    const first = openStorage(path);
    first.transaction((tx) => {
      tx.insertProject({
        id: "demo",
        name: "Demo",
        roots: ["/repo"],
        builtin: false,
        createdAt: "t",
      });
      tx.appendEvent(envelope("demo", 1), HASH_A);
    });
    first.close();

    const second = openStorage(path);
    try {
      expect(second.project("demo")).toMatchObject({ id: "demo", roots: ["/repo"], head: 1 });
      expect([...second.events("demo")]).toHaveLength(1);
    } finally {
      second.close();
    }
  });

  it("refuses a database written by a newer schema than this code knows", () => {
    const path = join(dir(), "taskville.db");
    openStorage(path).close();
    const raw = new DatabaseSync(path);
    raw.prepare("INSERT INTO schema_migrations (version, applied_at) VALUES (?, ?)").run(999, "t");
    raw.close();
    expect(() => openStorage(path)).toThrow(StorageError);
  });

  it("does not create the Unsorted project by itself", () => {
    const storage = openStorage(join(dir(), "taskville.db"));
    try {
      expect(storage.project(UNSORTED_PROJECT_ID)).toBeUndefined();
    } finally {
      storage.close();
    }
  });
});

describe("file modes", () => {
  function looseBits(path: string): number {
    return statSync(path).mode & 0o077;
  }

  it("creates the database, WAL, and SHM files readable by the owner only", () => {
    const path = join(dir(), "taskville.db");
    const storage = openStorage(path);
    try {
      storage.transaction((tx) => {
        tx.insertProject({ id: "demo", name: "Demo", roots: [], builtin: false, createdAt: "t" });
        tx.appendEvent(envelope("demo", 1), HASH_A);
      });
      expect(statSync(path).mode & 0o777).toBe(0o600);
      for (const suffix of ["-wal", "-shm"]) {
        expect(existsSync(path + suffix)).toBe(true);
        expect(looseBits(path + suffix)).toBe(0);
      }
    } finally {
      storage.close();
    }
  });

  it("tightens an existing database file that is group or world readable", () => {
    const path = join(dir(), "taskville.db");
    openStorage(path).close();
    chmodSync(path, 0o644);
    writeFileSync(`${path}-wal`, "", { mode: 0o644 });
    chmodSync(`${path}-wal`, 0o644);
    const storage = openStorage(path);
    try {
      expect(statSync(path).mode & 0o777).toBe(0o600);
      expect(looseBits(`${path}-wal`)).toBe(0);
    } finally {
      storage.close();
    }
  });

  it("refuses a symlinked database path", () => {
    const target = join(dir(), "elsewhere.db");
    openStorage(target).close();
    const path = join(dir(), "taskville.db");
    symlinkSync(target, path);
    expect(() => openStorage(path)).toThrow(StorageError);
  });
});
