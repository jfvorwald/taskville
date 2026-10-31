// Unit tests for the perf helpers. Run with `pnpm perf:unit` (node:test, so they stay out of
// `pnpm check` with the rest of tests/perf).
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { growth, median, percentile, simulatedHour, summarize } from "./stats.ts";

describe("percentile (nearest rank)", () => {
  it("picks the nearest-rank value from unsorted samples", () => {
    const samples = [5, 1, 4, 2, 3, 10, 9, 8, 7, 6];
    assert.equal(percentile(samples, 50), 5);
    assert.equal(percentile(samples, 95), 10);
    assert.equal(percentile(samples, 100), 10);
    assert.equal(percentile(samples, 1), 1);
  });

  it("rejects an empty sample or a percentile outside 0..100", () => {
    assert.throws(() => percentile([], 50), RangeError);
    assert.throws(() => percentile([1], 101), RangeError);
  });

  it("does not reorder the caller's array", () => {
    const samples = [3, 1, 2];
    percentile(samples, 50);
    assert.deepEqual(samples, [3, 1, 2]);
  });
});

describe("median", () => {
  it("averages the middle two of an even sample", () => {
    assert.equal(median([4, 1, 3, 2]), 2.5);
    assert.equal(median([7]), 7);
  });
});

describe("growth", () => {
  it("is the relative change from the first value to the second", () => {
    assert.equal(growth(100, 109), 0.09);
    assert.equal(growth(200, 180), -0.1);
    assert.throws(() => growth(0, 1), RangeError);
  });
});

describe("summarize", () => {
  it("reports count, p50, p95, p99, and max", () => {
    const samples = Array.from({ length: 100 }, (_, i) => i + 1);
    assert.deepEqual(summarize(samples), { count: 100, p50: 50, p95: 95, p99: 99, max: 100 });
  });
});

describe("simulatedHour", () => {
  it("counts whole simulated hours since the run started", () => {
    const start = Date.parse("2026-10-30T09:00:00Z");
    assert.equal(simulatedHour(start, "2026-10-30T09:59:59Z"), 0);
    assert.equal(simulatedHour(start, "2026-10-30T10:00:00Z"), 1);
    assert.equal(simulatedHour(start, "2026-10-30T17:00:00.500Z"), 8);
  });
});
