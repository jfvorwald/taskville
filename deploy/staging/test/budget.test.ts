// CPU regression tripwire, not a benchmark. The Workers limit that matters (10 ms of CPU per
// request) cannot be proven from Node, and a loaded machine slows everything. So this times only
// the request path (the module is loaded, and the session made, in `beforeAll`) and compares it
// with a cheap request measured in the same process: if the first snapshot or a timeline scrub
// grows to many times a trivial request, work has crept back into the request path (for example
// the demo run being rebuilt per request). Bounds are loose on purpose, with absolute floors for
// a quiet machine and a multiple of the baseline for a busy one.

import { beforeAll, describe, expect, it, vi } from "vitest";
import { makeStagingFrom, pair, type Staging, withSession } from "./support.ts";

const FIRST_FLOOR_MS = 25;
const FIRST_MULTIPLE = 60;
const SCRUB_FLOOR_MS = 10;
const SCRUB_MULTIPLE = 30;

let staging: Staging;
let session: string;

beforeAll(async () => {
  // Module load is where the demo is built (not request time), so it stays out of the timings.
  vi.resetModules();
  staging = makeStagingFrom(await import("../src/worker.ts"));
  session = await pair(staging);
});

async function timed(path: string): Promise<{ ms: number; body: { cursor?: number } }> {
  const started = performance.now();
  const response = await staging.call(path, withSession(session));
  const body = (await response.json()) as { cursor?: number };
  return { ms: performance.now() - started, body };
}

describe("request path cost", () => {
  it("serves the first snapshot and timeline scrubs near the cost of a trivial request", async () => {
    // Measured first, so the snapshot really is the first demo read in this isolate.
    const first = await timed("/v1/projects/demo/snapshot");
    const head = first.body.cursor ?? 1;

    const baselines: number[] = [];
    for (let i = 0; i < 30; i++) baselines.push((await timed("/health")).ms);
    baselines.sort((a, b) => a - b);
    const baseline = Math.max(baselines[Math.floor(baselines.length / 2)] ?? 0, 0.05);

    const scrubs: number[] = [];
    for (const fraction of [1, 0.25, 0.5, 0.75, 1]) {
      const at = Math.max(1, Math.floor(head * fraction));
      scrubs.push((await timed(`/v1/timelines/live:demo/state?at=${at}`)).ms);
    }
    const worst = Math.max(...scrubs);
    const firstBound = Math.max(FIRST_FLOOR_MS, FIRST_MULTIPLE * baseline);
    const scrubBound = Math.max(SCRUB_FLOOR_MS, SCRUB_MULTIPLE * baseline);
    console.info(
      `budget: baseline ${baseline.toFixed(2)} ms; first snapshot ${first.ms.toFixed(1)} ms (bound ${firstBound.toFixed(1)}); scrubs ${scrubs.map((m) => m.toFixed(1)).join(", ")} ms (bound ${scrubBound.toFixed(1)}); events ${head}`,
    );
    expect(first.ms).toBeLessThan(firstBound);
    expect(worst).toBeLessThan(scrubBound);
  });
});
