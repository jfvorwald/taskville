import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { stateHash } from "@taskville/domain/hash";
import { storedEnvelopeSchema } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  ensureUnsortedProject,
  openStorage,
  rebuildProjection,
  rebuildStaleProjections,
  type Storage,
  StorageError,
  UNSORTED_PROJECT_ID,
} from "../../src/storage/index.ts";
import { envelope, HASH_A, type StandInState, standInReducer, useTempDir } from "./helpers.ts";

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

/** Ingests events the way #13 will: append, apply, write projection, one transaction per batch. */
function ingestIncrementally(projectId: string, batches: number[][], version = 1): string {
  const reducer = standInReducer(version);
  let state = storage.projection<StandInState>(projectId)?.state ?? reducer.initial(projectId);
  let hash = "";
  for (const batch of batches) {
    storage.transaction((tx) => {
      for (const seq of batch) {
        const event = envelope(projectId, seq);
        tx.appendEvent(event, HASH_A);
        state = reducer.apply(state, event);
      }
      hash = tx.writeProjection({
        projectId,
        reducerVersion: reducer.version,
        head: tx.head(projectId) ?? 0,
        state,
      });
    });
  }
  return hash;
}

describe("writeProjection", () => {
  it("stores state, reducer version, head, and the stateHash it returns", () => {
    const hash = ingestIncrementally("p1", [[1, 2]]);
    const projection = storage.projection<StandInState>("p1");
    expect(projection?.head).toBe(2);
    expect(projection?.reducerVersion).toBe(1);
    expect(projection?.stateHash).toBe(hash);
    expect(hash).toBe(stateHash(1, projection?.state));
    expect(projection?.state.trail).toEqual(["1:e-1", "2:e-2"]);
  });

  it("refuses a projection whose head is not the project head", () => {
    storage.transaction((tx) => tx.appendEvent(envelope("p1", 1), HASH_A));
    expect(() =>
      storage.transaction((tx) =>
        tx.writeProjection({ projectId: "p1", reducerVersion: 1, head: 0, state: {} }),
      ),
    ).toThrow(StorageError);
    expect(storage.projection("p1")).toBeUndefined();
  });

  it("is rolled back with the events when the transaction fails", () => {
    expect(() =>
      storage.transaction((tx) => {
        tx.appendEvent(envelope("p1", 1), HASH_A);
        tx.writeProjection({ projectId: "p1", reducerVersion: 1, head: 1, state: { a: 1 } });
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(storage.projection("p1")).toBeUndefined();
    expect(storage.head("p1")).toBe(0);
  });
});

describe("rebuild from events", () => {
  it("produces the same hash as incremental application", () => {
    const incremental = ingestIncrementally("p1", [[1, 2, 3], [4], [5, 6, 7, 8]]);
    ingestIncrementally("p2", [[1]]);

    const rebuilt = rebuildProjection(storage, "p1", standInReducer(1));
    expect(rebuilt.stateHash).toBe(incremental);
    expect(rebuilt.head).toBe(8);
    expect(storage.projection("p1")?.stateHash).toBe(incremental);
  });

  it("replays in ingest-sequence order", () => {
    ingestIncrementally("p1", [[1, 2, 3]]);
    const rebuilt = rebuildProjection(storage, "p1", standInReducer(1));
    expect(rebuilt.state.trail).toEqual(["1:e-1", "2:e-2", "3:e-3"]);
  });

  it("rebuilds an empty project to the reducer's initial state", () => {
    const reducer = standInReducer(1);
    const rebuilt = rebuildProjection(storage, "p2", reducer);
    expect(rebuilt.head).toBe(0);
    expect(rebuilt.stateHash).toBe(stateHash(1, reducer.initial("p2")));
  });

  it("rebuilds only projects whose projection is missing, stale, or behind", () => {
    ingestIncrementally("p1", [[1, 2]], 1);
    ingestIncrementally("p2", [[1]], 2);
    storage.transaction((tx) =>
      tx.insertProject({ id: "p3", name: "Three", roots: [], builtin: false, createdAt: "t" }),
    );

    const rebuilt = rebuildStaleProjections(storage, standInReducer(2));
    expect(rebuilt.sort()).toEqual(["p1", "p3"]);
    expect(storage.projection("p1")?.reducerVersion).toBe(2);
    expect(storage.projection("p1")?.stateHash).toMatch(/^2:/);
    expect(rebuildStaleProjections(storage, standInReducer(2))).toEqual([]);
  });

  it("carries a reducer version change across a restart", () => {
    const v1 = ingestIncrementally("p1", [[1, 2, 3]], 1);
    storage.close();
    storage = openStorage(path);
    expect(storage.projection("p1")?.stateHash).toBe(v1);
    expect(rebuildStaleProjections(storage, standInReducer(2))).toEqual(["p1", "p2"]);
    expect(storage.projection("p1")?.stateHash).toBe(stateHash(2, storage.projection("p1")?.state));
  });
});

describe("Unsorted project", () => {
  it("is created once, as a builtin project whose first event is a valid project.created", () => {
    expect(
      ensureUnsortedProject(storage, { now: () => new Date(Date.parse("2026-10-30T12:00:00Z")) }),
    ).toBe(true);
    expect(ensureUnsortedProject(storage)).toBe(false);

    const project = storage.project(UNSORTED_PROJECT_ID);
    expect(project).toMatchObject({ id: "unsorted", name: "Unsorted", builtin: true, head: 1 });
    const events = [...storage.events(UNSORTED_PROJECT_ID)];
    expect(events).toHaveLength(1);
    const [created] = events;
    expect(storedEnvelopeSchema.parse(created)).toEqual(created);
    expect(created).toMatchObject({
      type: "project.created",
      ingestSequence: 1,
      payload: { name: "Unsorted", roots: [], builtin: true },
    });
    expect(created?.sourceId.startsWith("taskville:")).toBe(true);
    expect(
      storage.findEventBySourceKey(
        "unsorted",
        created?.sourceId ?? "",
        created?.sourceEventId ?? "",
      )?.contentHash,
    ).toMatch(/^[0-9a-f]{64}$/);
  });

  it("gets its projection from the boot rebuild", () => {
    ensureUnsortedProject(storage);
    expect(rebuildStaleProjections(storage, standInReducer(1))).toContain(UNSORTED_PROJECT_ID);
    expect(storage.projection(UNSORTED_PROJECT_ID)?.head).toBe(1);
  });

  it("cannot be removed", () => {
    ensureUnsortedProject(storage);
    const raw = new DatabaseSync(path, { timeout: 1000 });
    try {
      raw.exec("PRAGMA foreign_keys = OFF");
      expect(() => raw.exec("DELETE FROM projects WHERE id = 'unsorted'")).toThrow(/builtin/);
    } finally {
      raw.close();
    }
    expect(storage.project(UNSORTED_PROJECT_ID)).toBeDefined();
  });
});
