import { existsSync, statSync } from "node:fs";
import { join } from "node:path";
import { stateHash } from "@taskville/domain/hash";
import { describe, expect, it } from "vitest";
import { generateDemo, LIVELY } from "../../../../packages/demo/src/index.ts";
import { domainReducer, IngestPipeline } from "../../src/ingest/index.ts";
import {
  ensureUnsortedProject,
  JOURNAL_SIZE_LIMIT_BYTES,
  openStorage,
  PAGE_CACHE_KIB,
  WAL_AUTOCHECKPOINT_PAGES,
} from "../../src/storage/index.ts";
import { addProject } from "../ingest/helpers.ts";
import { useTempDir } from "./helpers.ts";

// #166 step 2 and the storage half of step 1: explicit SQLite memory settings, a bounded WAL,
// one serialization per projection write, and a projection read that does not parse state.

const dir = useTempDir();

function open() {
  const storage = openStorage(join(dir(), "taskville.db"));
  ensureUnsortedProject(storage);
  return storage;
}

describe("SQLite memory and WAL settings", () => {
  it("sets the page cache, the WAL autocheckpoint, and the journal size limit explicitly", () => {
    const storage = open();
    try {
      expect(storage.pragma("cache_size")).toBe(-PAGE_CACHE_KIB);
      expect(storage.pragma("wal_autocheckpoint")).toBe(WAL_AUTOCHECKPOINT_PAGES);
      expect(storage.pragma("journal_size_limit")).toBe(JOURNAL_SIZE_LIMIT_BYTES);
      expect(PAGE_CACHE_KIB).toBeGreaterThan(0);
    } finally {
      storage.close();
    }
  });

  it("keeps the -wal file bounded through a long ingest", () => {
    const storage = open();
    try {
      addProject(storage, "demo");
      const pipeline = new IngestPipeline({ storage });
      const wal = join(dir(), "taskville.db-wal");
      let largest = 0;
      let events = 0;
      for (const step of generateDemo({
        seed: 3,
        pace: LIVELY,
        projectId: "demo",
        durationMs: 2 * 3_600_000,
      })) {
        pipeline.ingest([...step.events]);
        events += step.events.length;
        if (existsSync(wal)) largest = Math.max(largest, statSync(wal).size);
      }
      expect(events).toBeGreaterThan(2_500);
      // One autocheckpoint interval of pages plus one batch's worth, never the whole run.
      expect(largest).toBeLessThan(
        2 * Math.max(JOURNAL_SIZE_LIMIT_BYTES, WAL_AUTOCHECKPOINT_PAGES * 4096),
      );
    } finally {
      storage.close();
    }
  });
});

describe("projectionMeta", () => {
  it("returns the stored version, head, and stateHash without the state, inside and outside a transaction", () => {
    const storage = open();
    try {
      addProject(storage, "demo");
      expect(storage.projectionMeta("demo")).toBeUndefined();
      const pipeline = new IngestPipeline({ storage });
      for (const step of generateDemo({
        seed: 1,
        pace: LIVELY,
        projectId: "demo",
        durationMs: 600_000,
      })) {
        pipeline.ingest([...step.events]);
      }
      const full = storage.projection("demo");
      const meta = storage.projectionMeta("demo");
      expect(meta).toEqual({
        reducerVersion: full?.reducerVersion,
        head: full?.head,
        stateHash: full?.stateHash,
      });
      expect(storage.transaction((tx) => tx.projectionMeta("demo"))).toEqual(meta);
      expect(storage.projectionMeta("nope")).toBeUndefined();
    } finally {
      storage.close();
    }
  });
});

describe("writeProjection hash", () => {
  it("is exactly stateHash(reducerVersion, state) for a large state", () => {
    const storage = open();
    try {
      addProject(storage, "demo");
      const pipeline = new IngestPipeline({ storage });
      for (const step of generateDemo({
        seed: 9,
        pace: LIVELY,
        projectId: "demo",
        durationMs: 1_800_000,
      })) {
        pipeline.ingest([...step.events]);
      }
      const stored = storage.projection("demo");
      expect(stored?.stateHash).toBe(stateHash(domainReducer.version, stored?.state));
    } finally {
      storage.close();
    }
  });

  it("refuses a reducer version that is not a non-negative safe integer, as stateHash does", () => {
    const storage = open();
    try {
      addProject(storage, "demo");
      for (const reducerVersion of [-1, 1.5, Number.NaN]) {
        expect(() =>
          storage.transaction((tx) =>
            tx.writeProjection({ projectId: "demo", reducerVersion, head: 1, state: {} }),
          ),
        ).toThrow(RangeError);
      }
    } finally {
      storage.close();
    }
  });
});
