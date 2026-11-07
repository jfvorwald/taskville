// CPU budget, measured in Node as a proxy for a Worker's limit: the first snapshot (which builds
// the demo run) and one timeline state scrub at the default demo size. Generous thresholds, so a
// pass means "comfortably cheap", and a fail means "precompute".

import { afterEach, describe, expect, it, vi } from "vitest";
import { makeStagingFrom, pair, withSession } from "./support.ts";

const FIRST_REQUEST_MS = 50;
const SCRUB_MS = 10;

afterEach(() => {
  vi.useRealTimers();
});

describe("CPU budget", () => {
  it("serves the first snapshot and timeline scrubs inside the budget", async () => {
    vi.resetModules();
    const staging = makeStagingFrom(await import("../src/worker.ts"));
    const session = await pair(staging);

    const started = performance.now();
    const snapshot = await staging.call("/v1/projects/demo/snapshot", withSession(session));
    const body = (await snapshot.json()) as { cursor: number };
    const first = performance.now() - started;

    const positions = [1, 0.25, 0.5, 0.75, 1].map((fraction) =>
      Math.max(1, Math.floor(body.cursor * fraction)),
    );
    const scrubs: number[] = [];
    for (const at of positions) {
      const t = performance.now();
      const response = await staging.call(
        `/v1/timelines/live:demo/state?at=${at}`,
        withSession(session),
      );
      await response.arrayBuffer();
      scrubs.push(performance.now() - t);
    }
    const worst = Math.max(...scrubs);
    console.info(
      `budget: first snapshot ${first.toFixed(1)} ms; scrubs ${scrubs.map((m) => m.toFixed(1)).join(", ")} ms; events ${body.cursor}`,
    );
    expect(first).toBeLessThan(FIRST_REQUEST_MS);
    expect(worst).toBeLessThan(SCRUB_MS);
  });
});
