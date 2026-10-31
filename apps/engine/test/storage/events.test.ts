import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStorage, type Storage, StorageError } from "../../src/storage/index.ts";
import { envelope, HASH_A, useTempDir } from "./helpers.ts";

const dir = useTempDir();
let storage: Storage;
let path: string;

beforeEach(() => {
  path = join(dir(), "taskville.db");
  storage = openStorage(path);
  storage.transaction((tx) => {
    tx.insertProject({ id: "p1", name: "One", roots: [], builtin: false, createdAt: "t" });
    tx.insertProject({ id: "p2", name: "Two", roots: [], builtin: false, createdAt: "t" });
  });
});

afterEach(() => {
  storage.close();
});

function rawDb(): DatabaseSync {
  return new DatabaseSync(path, { timeout: 1000 });
}

describe("appendEvent", () => {
  it("stores events, advances the project head, and reads them back in sequence order", () => {
    const events = [envelope("p1", 1), envelope("p1", 2), envelope("p1", 3)];
    storage.transaction((tx) => {
      for (const event of events) tx.appendEvent(event, HASH_A);
    });
    expect(storage.head("p1")).toBe(3);
    expect(storage.head("p2")).toBe(0);
    expect([...storage.events("p1")]).toEqual(events);
    expect([...storage.events("p1", 1)]).toEqual(events.slice(1));
  });

  it("finds a stored event by its source key, with its content hash", () => {
    const event = envelope("p1", 1);
    storage.transaction((tx) => tx.appendEvent(event, HASH_A));
    expect(storage.findEventBySourceKey("p1", "test-source", "e-1")).toEqual({
      eventId: event.eventId,
      ingestSequence: 1,
      contentHash: HASH_A,
      envelope: event,
    });
    expect(storage.findEventBySourceKey("p2", "test-source", "e-1")).toBeUndefined();
  });

  it("enforces (project, source, sourceEventId) uniqueness", () => {
    storage.transaction((tx) => tx.appendEvent(envelope("p1", 1), HASH_A));
    expect(() =>
      storage.transaction((tx) =>
        tx.appendEvent(envelope("p1", 2, { sourceEventId: "e-1" }), "b".repeat(64)),
      ),
    ).toThrow();
    expect(storage.head("p1")).toBe(1);
    expect(storage.findEventBySourceKey("p1", "test-source", "e-1")?.contentHash).toBe(HASH_A);
  });

  it("allows the same source key in a different project", () => {
    storage.transaction((tx) => {
      tx.appendEvent(envelope("p1", 1), HASH_A);
      tx.appendEvent(envelope("p2", 1), HASH_A);
    });
    expect(storage.head("p1")).toBe(1);
    expect(storage.head("p2")).toBe(1);
  });

  it("enforces a globally unique event ID", () => {
    const first = envelope("p1", 1);
    storage.transaction((tx) => tx.appendEvent(first, HASH_A));
    expect(() =>
      storage.transaction((tx) =>
        tx.appendEvent(envelope("p2", 1, { eventId: first.eventId }), HASH_A),
      ),
    ).toThrow();
  });

  it("rejects a sequence that is not head + 1, so the log stays gap-free", () => {
    expect(() => storage.transaction((tx) => tx.appendEvent(envelope("p1", 2), HASH_A))).toThrow();
    storage.transaction((tx) => tx.appendEvent(envelope("p1", 1), HASH_A));
    expect(() => storage.transaction((tx) => tx.appendEvent(envelope("p1", 1, { sourceEventId: "x" }), HASH_A))).toThrow();
    expect(storage.head("p1")).toBe(1);
  });

  it("rejects an event for a project that does not exist", () => {
    expect(() => storage.transaction((tx) => tx.appendEvent(envelope("nope", 1), HASH_A))).toThrow();
    expect(storage.project("nope")).toBeUndefined();
  });

  it("rejects a malformed content hash", () => {
    expect(() =>
      storage.transaction((tx) => tx.appendEvent(envelope("p1", 1), "not-a-hash")),
    ).toThrow(StorageError);
  });
});

describe("insert-only events table", () => {
  beforeEach(() => {
    storage.transaction((tx) => {
      tx.appendEvent(envelope("p1", 1), HASH_A);
      tx.appendEvent(envelope("p1", 2), HASH_A);
    });
  });

  it("aborts UPDATE on events from any connection", () => {
    const raw = rawDb();
    try {
      expect(() => raw.exec("UPDATE events SET type = 'x' WHERE ingest_sequence = 1")).toThrow(
        /insert-only/,
      );
    } finally {
      raw.close();
    }
    expect([...storage.events("p1")][0]?.type).toBe("agent.connected");
  });

  it("aborts DELETE on events from any connection", () => {
    const raw = rawDb();
    try {
      expect(() => raw.exec("DELETE FROM events")).toThrow(/insert-only/);
    } finally {
      raw.close();
    }
    expect([...storage.events("p1")]).toHaveLength(2);
  });

  it("aborts INSERT OR REPLACE over an existing event", () => {
    const raw = rawDb();
    try {
      expect(() =>
        raw.exec(
          `INSERT OR REPLACE INTO events SELECT project_id, ingest_sequence, 'replaced', source_id,
             source_event_id, source_sequence, occurred_at, received_at, type, schema_version,
             provenance, content_hash, envelope_json FROM events WHERE ingest_sequence = 1`,
        ),
      ).toThrow(/insert-only/);
    } finally {
      raw.close();
    }
    expect([...storage.events("p1")]).toHaveLength(2);
    expect(storage.findEventBySourceKey("p1", "test-source", "e-1")?.eventId).not.toBe("replaced");
  });
});

describe("transaction", () => {
  it("rolls back every write when the callback throws", () => {
    expect(() =>
      storage.transaction((tx) => {
        tx.appendEvent(envelope("p1", 1), HASH_A);
        tx.appendEvent(envelope("p1", 2), HASH_A);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(storage.head("p1")).toBe(0);
    expect([...storage.events("p1")]).toEqual([]);
  });

  it("returns the callback's result after commit", () => {
    expect(storage.transaction(() => 42)).toBe(42);
  });

  it("refuses nesting", () => {
    expect(() => storage.transaction(() => storage.transaction(() => 1))).toThrow(StorageError);
  });

  it("refuses an async callback and rolls back", () => {
    expect(() =>
      storage.transaction(async (tx) => {
        tx.appendEvent(envelope("p1", 1), HASH_A);
      }),
    ).toThrow(StorageError);
    expect(storage.head("p1")).toBe(0);
  });

  it("refuses writes through a transaction handle after it ends", () => {
    let leaked: Parameters<Parameters<Storage["transaction"]>[0]>[0] | undefined;
    storage.transaction((tx) => {
      leaked = tx;
    });
    expect(() => leaked?.appendEvent(envelope("p1", 1), HASH_A)).toThrow(StorageError);
    expect(storage.head("p1")).toBe(0);
  });

  it("holds the write lock, so another connection cannot write meanwhile", () => {
    storage.transaction((tx) => {
      tx.appendEvent(envelope("p1", 1), HASH_A);
      const raw = new DatabaseSync(path, { timeout: 0 });
      try {
        expect(() => raw.exec("BEGIN IMMEDIATE")).toThrow(/locked|busy/i);
      } finally {
        raw.close();
      }
    });
  });
});

describe("projects", () => {
  it("lists projects with their roots, builtin flag, and head", () => {
    expect(storage.projects().map((p) => p.id)).toEqual(["p1", "p2"]);
    expect(storage.project("p1")).toEqual({
      id: "p1",
      name: "One",
      roots: [],
      builtin: false,
      createdAt: "t",
      head: 0,
    });
  });

  it("rejects a duplicate project ID", () => {
    expect(() =>
      storage.transaction((tx) =>
        tx.insertProject({ id: "p1", name: "Again", roots: [], builtin: false, createdAt: "t" }),
      ),
    ).toThrow();
  });
});
