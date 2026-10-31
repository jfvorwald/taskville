// Unit tests for the perf harness (roborev 5005). Run with `pnpm perf:unit`.
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { type RunningEngine, startEngine } from "./engine.ts";
import { latencyPass } from "./latency.ts";
import { summarize } from "./stats.ts";
import { connectViewer } from "./viewer.ts";

const phase = (samples: number[], anomalies = 0) => ({
  name: "p",
  viewer: summarize(samples),
  ack: summarize(samples),
  demoEvents: 0,
  anomalies,
});

describe("latencyPass", () => {
  it("fails when any single probe reaches 250 ms, even with a low p95", () => {
    const samples = [...Array.from({ length: 99 }, () => 5), 300];
    assert.equal(summarize(samples).p95, 5);
    assert.equal(latencyPass([phase(samples)]), false);
    assert.equal(latencyPass([phase(Array.from({ length: 100 }, () => 5))]), true);
    assert.equal(latencyPass([phase([5], 1)]), false);
  });
});

/** A fake engine whose event stream sends `body` and then ends. */
function fakeEngine(body: string): RunningEngine {
  return {
    get: async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode(body));
            controller.close();
          },
        }),
        { status: 200 },
      ),
  } as unknown as RunningEngine;
}

describe("viewer", () => {
  it("rejects pending and later waits when the stream ends", async () => {
    const viewer = await connectViewer(fakeEngine(""), "p", 1);
    await assert.rejects(viewer.arrival("probe-x"), /stream ended/);
    await assert.rejects(viewer.reach(5), /stream ended/);
  });

  it("rejects waits when the engine sends resnapshot", async () => {
    const viewer = await connectViewer(
      fakeEngine('event: resnapshot\ndata: {"reason":"slow_consumer"}\n\n'),
      "p",
      1,
    );
    await assert.rejects(viewer.reach(2), /resnapshot slow_consumer/);
  });

  it("rejects a wait that is never satisfied after its timeout", async () => {
    const viewer = await connectViewer(
      {
        get: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
      } as unknown as RunningEngine,
      "p",
      1,
      { waitTimeoutMs: 50 },
    );
    await assert.rejects(viewer.arrival("probe-y"), /timed out/);
    viewer.close();
  });
});

describe("startEngine", () => {
  it("stop() returns when the engine already exited on its own", async () => {
    const engine = await startEngine();
    process.kill(engine.pid, "SIGKILL");
    await new Promise((r) => setTimeout(r, 200));
    const result = await Promise.race([
      engine.stop().then(() => "stopped"),
      new Promise((r) => setTimeout(() => r("hung"), 5000)),
    ]);
    assert.equal(result, "stopped");
  });
});
