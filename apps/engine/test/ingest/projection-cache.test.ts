import { stateHash } from "@taskville/domain/hash";
import { initialState, type ProjectState, reduce } from "@taskville/domain/reducer";
import { describe, expect, it, vi } from "vitest";
import { generateDemo, LIVELY } from "../../../../packages/demo/src/index.ts";
import { domainReducer, IngestPipeline } from "../../src/ingest/index.ts";
import { openStorage, type ProjectionReducer, type Storage } from "../../src/storage/index.ts";
import { fixedNow, useStorage } from "./helpers.ts";

// #166 step 1: the pipeline keeps the parsed projection between batches instead of reading and
// parsing `state_json` on every batch. These tests pin that the cached path is the cold path.

const PROJECT = "demo";
const batches = () =>
  generateDemo({ seed: 7, pace: LIVELY, projectId: PROJECT, durationMs: 20 * 60_000 }).map(
    (step) => [...step.events],
  );

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const child of Object.values(value)) deepFreeze(child);
  }
  return value;
}

/** The domain reducer, with every state it is given or returns frozen: a mutation would throw. */
const frozenReducer: ProjectionReducer<ProjectState> = {
  version: domainReducer.version,
  initial: (projectId) => deepFreeze(initialState(projectId)),
  apply: (state, event) => deepFreeze(reduce(deepFreeze(state), event)),
};

/** Deterministic event IDs, so two databases fed the same events hold byte-identical state. */
function idSequence(): () => string {
  let n = 0;
  return () => `00000000-0000-4000-8000-${(n++).toString(16).padStart(12, "0")}`;
}

/** The stateHash of a full replay of the project's log: the cold path, from scratch. */
function replayHash(storage: Storage): string {
  let state = domainReducer.initial(PROJECT);
  for (const event of storage.events(PROJECT)) state = domainReducer.apply(state, event);
  return stateHash(domainReducer.version, state);
}

describe("projection cache in the ingest pipeline (#166)", () => {
  const db = useStorage([PROJECT]);
  const cold = useStorage([PROJECT]);

  it("gives the same stateHash as a cold pipeline and a full replay after every batch", () => {
    const cachedIds = idSequence();
    const coldIds = idSequence();
    const cached = new IngestPipeline({
      storage: db.storage(),
      now: fixedNow,
      reducer: frozenReducer,
      newEventId: cachedIds,
    });
    let n = 0;
    for (const batch of batches()) {
      cached.ingest(batch);
      // A new pipeline per batch has no cache: it reads and parses the stored projection.
      new IngestPipeline({ storage: cold.storage(), now: fixedNow, newEventId: coldIds }).ingest(
        batch,
      );
      const hash = db.storage().projection(PROJECT)?.stateHash;
      expect(hash, `batch ${n}`).toBe(cold.storage().projection(PROJECT)?.stateHash);
      if (n % 25 === 0) expect(hash, `batch ${n}`).toBe(replayHash(db.storage()));
      n++;
    }
    expect(n).toBeGreaterThan(60);
    expect(db.storage().head(PROJECT)).toBe(cold.storage().head(PROJECT));
  }, 30_000);

  it("reads the stored projection once, then keeps it in memory", () => {
    const storage = db.storage();
    const read = vi.spyOn(storage, "projection");
    const pipeline = new IngestPipeline({ storage, now: fixedNow });
    const all = batches().slice(0, 20);
    for (const batch of all) pipeline.ingest(batch);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("re-reads from disk after a restart (a new pipeline) and continues identically", () => {
    const all = batches().slice(0, 40);
    const first = new IngestPipeline({ storage: db.storage(), now: fixedNow });
    for (const batch of all.slice(0, 20)) first.ingest(batch);
    const read = vi.spyOn(db.storage(), "projection");
    const second = new IngestPipeline({ storage: db.storage(), now: fixedNow });
    for (const batch of all.slice(20)) second.ingest(batch);
    expect(read).toHaveBeenCalledTimes(1);
    expect(db.storage().projection(PROJECT)?.stateHash).toBe(replayHash(db.storage()));
  });

  it("re-reads when another connection rewrote the projection at the same head", () => {
    const all = batches().slice(0, 10);
    const pipeline = new IngestPipeline({ storage: db.storage(), now: fixedNow });
    for (const batch of all.slice(0, 5)) pipeline.ingest(batch);

    // Another writer (a second engine process, a rebuild) replaces the projection in place.
    const other = openStorage(db.path());
    try {
      other.transaction((tx) => {
        const current = tx.projection<ProjectState>(PROJECT);
        if (!current) throw new Error("no projection");
        tx.writeProjection({
          projectId: PROJECT,
          reducerVersion: current.reducerVersion,
          head: current.head,
          state: { ...current.state, marker: "rewritten" },
        });
      });
    } finally {
      other.close();
    }
    for (const batch of all.slice(5)) pipeline.ingest(batch);
    const state = db.storage().projection<Record<string, unknown>>(PROJECT)?.state;
    expect(state?.marker).toBe("rewritten");
  });

  it("re-reads when another connection appended events (the head moved)", () => {
    const all = batches().slice(0, 12);
    const pipeline = new IngestPipeline({ storage: db.storage(), now: fixedNow });
    for (const batch of all.slice(0, 4)) pipeline.ingest(batch);
    const other = openStorage(db.path());
    try {
      for (const batch of all.slice(4, 8)) new IngestPipeline({ storage: other }).ingest(batch);
    } finally {
      other.close();
    }
    for (const batch of all.slice(8)) pipeline.ingest(batch);
    expect(db.storage().projection(PROJECT)?.stateHash).toBe(replayHash(db.storage()));
  });

  it("keeps the cache right after a batch that rolled back", () => {
    const all = batches().slice(0, 30);
    let failOn = -1;
    let applied = 0;
    const flaky: ProjectionReducer<ProjectState> = {
      ...frozenReducer,
      apply: (state, event) => {
        if (applied++ === failOn) throw new Error("reducer failed mid-batch");
        return frozenReducer.apply(state, event);
      },
    };
    const pipeline = new IngestPipeline({ storage: db.storage(), now: fixedNow, reducer: flaky });
    for (const batch of all.slice(0, 10)) pipeline.ingest(batch);
    const before = db.storage().projection(PROJECT)?.stateHash;
    const failing = all[10] ?? [];
    expect(failing.length).toBeGreaterThan(1);
    failOn = applied + 1; // the second event of the next batch
    expect(() => pipeline.ingest(failing)).toThrow("reducer failed mid-batch");
    expect(db.storage().projection(PROJECT)?.stateHash).toBe(before);
    failOn = -1;
    for (const batch of all.slice(10)) pipeline.ingest(batch);
    expect(db.storage().projection(PROJECT)?.stateHash).toBe(replayHash(db.storage()));
  });
});
