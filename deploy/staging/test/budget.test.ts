// CPU regression tripwire, not a benchmark. The Workers limit that matters (10 ms of CPU per
// request) cannot be proven from Node, and a loaded machine slows everything. So this measures only
// the request path (the module is loaded, and the session made, in `beforeAll`) and compares it
// with a cheap request measured in the same process: if the first snapshot or a timeline scrub
// grows to many times a trivial request, work has crept back into the request path (for example
// the demo run being rebuilt per request). Bounds are loose on purpose, with absolute floors for
// a quiet machine and a multiple of the baseline for a busy one.

import { describe, expect, it, vi } from "vitest";
import { makeStagingFrom, pair, type Staging, withSession } from "./support.ts";

const FIRST_FLOOR_MS = 25;
const FIRST_MULTIPLE = 60;
const SCRUB_FLOOR_MS = 10;
const SCRUB_MULTIPLE = 30;

const FIRST_SAMPLES = 3;

type Instance = { staging: Staging; session: string };

/** A fresh module graph: the demo is built at module load (not request time), outside the timings. */
async function freshInstance(): Promise<Instance> {
  vi.resetModules();
  const staging = makeStagingFrom(await import("../src/worker.ts"));
  return { staging, session: await pair(staging) };
}

// CPU time (user + system, this process) rather than wall time: a loaded machine stretches wall
// time with scheduling waits, but the CPU a request burns stays close to constant.
// The request path is in-process and synchronous enough that CPU time covers it.
async function timed(
  { staging, session }: Instance,
  path: string,
): Promise<{ ms: number; body: { cursor?: number } }> {
  const before = process.cpuUsage();
  const response = await staging.call(path, withSession(session));
  const body = (await response.json()) as { cursor?: number };
  const used = process.cpuUsage(before);
  return { ms: (used.user + used.system) / 1000, body };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? 0;
}

describe("request path cost", () => {
  it("serves the first snapshot and timeline scrubs near the cost of a trivial request", async () => {
    // The first snapshot is a one-shot per isolate (it builds the demo state), so it is sampled on
    // several fresh instances and the median is judged; each is that instance's first demo read.
    const firsts: number[] = [];
    let instance = await freshInstance();
    let head = 1;
    for (let i = 0; i < FIRST_SAMPLES; i++) {
      if (i > 0) instance = await freshInstance();
      const first = await timed(instance, "/v1/projects/demo/snapshot");
      firsts.push(first.ms);
      head = first.body.cursor ?? head;
    }
    const firstMs = median(firsts);

    // Scrubs are sampled in rounds, each round interleaved with a trivial request, so a slow
    // patch hits both sides; each point and the baseline use the median of its samples.
    const fractions = [1, 0.25, 0.5, 0.75, 1];
    const rounds = 5;
    const baselines: number[] = [];
    const samples: number[][] = fractions.map(() => []);
    for (let round = 0; round < rounds; round++) {
      for (let i = 0; i < 6; i++) baselines.push((await timed(instance, "/health")).ms);
      for (const [index, fraction] of fractions.entries()) {
        // A different position each round: the worker caches states, and a cache hit would hide cost.
        const at = Math.max(1, Math.floor(head * fraction) - round);
        samples[index]?.push((await timed(instance, `/v1/timelines/live:demo/state?at=${at}`)).ms);
      }
    }
    const baseline = Math.max(median(baselines), 0.05);
    const scrubs = samples.map(median);
    const worst = Math.max(...scrubs);
    const firstBound = Math.max(FIRST_FLOOR_MS, FIRST_MULTIPLE * baseline);
    const scrubBound = Math.max(SCRUB_FLOOR_MS, SCRUB_MULTIPLE * baseline);
    console.info(
      `budget (cpu): baseline ${baseline.toFixed(2)} ms; first snapshot ${firstMs.toFixed(1)} ms (bound ${firstBound.toFixed(1)}); scrubs ${scrubs.map((m) => m.toFixed(1)).join(", ")} ms (bound ${scrubBound.toFixed(1)}); events ${head}`,
    );
    expect(firstMs).toBeLessThan(firstBound);
    expect(worst).toBeLessThan(scrubBound);
  });
});
