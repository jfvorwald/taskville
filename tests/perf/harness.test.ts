// Unit tests for the perf harness (roborev 5005). Run with `pnpm perf:unit`.
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { describe, it } from "node:test";
import { type RunningEngine, startEngine } from "./engine.ts";
import { latencyPass, probe } from "./latency.ts";
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

describe("probe", () => {
  it("rejects (rather than crashing the runner) when the viewer times out during a slow ingest", async () => {
    const viewer = await connectViewer(
      {
        get: async () => new Response(new ReadableStream({ start() {} }), { status: 200 }),
      } as unknown as RunningEngine,
      "p",
      1,
      { waitTimeoutMs: 20 },
    );
    const slow = {
      ingest: () =>
        new Promise((done) =>
          setTimeout(() => done({ results: [{ status: "accepted" }], heads: {} }), 200),
        ),
    } as unknown as RunningEngine;
    await assert.rejects(probe(slow, viewer, "slow", 1, 0), /timed out/);
    viewer.close();
  });
});

/** Node flags of the documented engine launch, `pnpm taskville` (the root package.json script). */
function launchFlags(): string[] {
  const root = resolve(import.meta.dirname, "../..");
  const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
  const [node, ...rest] = String(pkg.scripts.taskville).split(/\s+/);
  assert.equal(node, "node");
  return rest.filter((token) => token.startsWith("--"));
}

describe("engine memory flags (#166, SC-006)", () => {
  it("the taskville launch caps V8's semi-spaces at 8 MiB", () => {
    assert.ok(launchFlags().includes("--max-semi-space-size=8"), `flags: ${launchFlags()}`);
  });

  it("the launch flags hold the young generation at 16 MiB under churn (default grows to 64 MiB)", () => {
    // Short-lived garbage with a little survival, as each ingest batch makes. Without the cap,
    // V8 doubles the new space up to 64 MiB on this class of machine and never gives it back:
    // that one-time step was most of SC-006's hour-1-to-8 RSS growth in the calm soak.
    const churn = `
      const v8 = require("node:v8");
      let keep = [];
      for (let i = 0; i < 6e6; i++) {
        const o = { a: i, b: "x" + i, c: [i] };
        if (i % 50 === 0) keep.push(o);
        if (keep.length > 20000) keep = [];
      }
      const s = v8.getHeapSpaceStatistics().find((x) => x.space_name === "new_space");
      process.stdout.write(String(s.space_size));`;
    const bytes = Number(execFileSync(process.execPath, [...launchFlags(), "-e", churn]));
    assert.ok(bytes <= 16 * 2 ** 20, `new space ${(bytes / 2 ** 20).toFixed(1)} MiB`);
  });

  it("startEngine launches the engine with the same node flags as `pnpm taskville`", async () => {
    const engine = await startEngine();
    try {
      const args = execFileSync("ps", ["-o", "args=", "-p", String(engine.pid)]).toString();
      assert.ok(args.includes("--max-semi-space-size=8"), args);
      for (const flag of launchFlags()) assert.ok(args.includes(flag), `${flag} missing: ${args}`);
    } finally {
      await engine.stop();
    }
  });
});

describe("startEngine cleanup", () => {
  it("kills the child and removes its home when startup times out", async () => {
    let spawned: { pid: number; home: string } | undefined;
    await assert.rejects(
      startEngine({ startupTimeoutMs: 1, onSpawn: (pid, home) => (spawned = { pid, home }) }),
      /did not start/,
    );
    assert.ok(spawned);
    assert.equal(existsSync(spawned.home), false);
    assert.throws(() => process.kill(spawned?.pid ?? 0, 0));
  });
});
