// M6.01 seek measurement: how long `GET /v1/timelines/:id/state?at=` takes on a day-sized demo
// log (ARCHITECTURE.md 7.4: add checkpoints only if seeks exceed 300 ms). Not part of
// `pnpm check`: run it once and post the numbers in the PR.
//
//   node tests/perf/seek.ts [calm|lively] [runs]
//
// calm is about 10,000 events a simulated day, lively about 50,000. Boots the engine in process
// (real SQLite in a throwaway directory, the real routes through the security middleware),
// seeds the day, then seeks to several positions, `runs` times each (default 7), and prints
// min, median, p95 and max per position next to a bare reducer replay of the same events.
// Exit code 1 if any seek is not a 200; the 300 ms verdict is printed, never gated.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { PairingStore } from "../../apps/engine/src/auth/pairing.ts";
import { createApp } from "../../apps/engine/src/http/app.ts";
import { bootEngine } from "../../apps/engine/src/stream/index.ts";
import {
  AFTER_DAY,
  CALM,
  DAY_PROJECT,
  dayEvents,
  LIVELY,
  seedLog,
} from "../../apps/engine/test/timelines/day-log.ts";
import { replay } from "../../packages/domain/src/reducer/index.ts";
import { median, percentile } from "./stats.ts";

const paceName = process.argv[2] ?? "calm";
const runs = Number(process.argv[3] ?? 7);
if (!["calm", "lively"].includes(paceName) || !Number.isInteger(runs) || runs < 1) {
  console.error("Usage: node tests/perf/seek.ts [calm|lively] [runs]");
  process.exit(2);
}
const TARGET_MS = 300;
const TOKEN = "seek-token-0123456789abcdefghijklmnopqrstuvwxyzABCD";
const BRIDGE = "seek-bridge-0123456789abcdefghijklmnopqrstuvwxyzAB";
const PORT = 4807;

const dir = mkdtempSync(join(tmpdir(), "taskville-seek-"));
let failed = false;
try {
  const pairing = new PairingStore();
  const app = createApp({ port: PORT, cliToken: TOKEN, bridgeToken: BRIDGE, pairing });
  const engine = bootEngine({
    app,
    dbPath: join(dir, "taskville.db"),
    pairing,
    now: () => AFTER_DAY,
    heartbeatMs: 60_000,
  });
  const events = dayEvents(paceName === "calm" ? CALM : LIVELY);
  const seedStart = performance.now();
  seedLog(engine.storage, events);
  const seedMs = performance.now() - seedStart;
  const head = events.length;

  console.log(
    `# Timeline seek (${new Date().toISOString()}), Node ${process.version}, ${paceName} day, ${head} events (seeded in ${seedMs.toFixed(0)} ms), ${runs} runs per position`,
  );
  console.log("| Position | at | seek min | seek p50 | seek p95 | seek max | bare replay |");
  console.log("| --- | --- | --- | --- | --- | --- | --- |");

  const positions: Array<[string, number]> = [
    ["start", 1],
    ["after 500", 501],
    ["10%", Math.floor(head * 0.1)],
    ["25%", Math.floor(head * 0.25)],
    ["50%", Math.floor(head * 0.5)],
    ["75%", Math.floor(head * 0.75)],
    ["90%", Math.floor(head * 0.9)],
    ["head", head],
  ];
  let worstP95 = 0;
  for (const [label, at] of positions) {
    const samples: number[] = [];
    for (let i = 0; i < runs; i++) {
      const started = performance.now();
      const res = await app.request(
        `http://127.0.0.1:${PORT}/v1/timelines/live:${DAY_PROJECT}/state?at=${at}`,
        {
          headers: { Host: `127.0.0.1:${PORT}`, Authorization: `Bearer ${TOKEN}` },
        },
      );
      const body = await res.text();
      samples.push(performance.now() - started);
      if (res.status !== 200) {
        failed = true;
        console.error(`seek at=${at} answered ${res.status}: ${body.slice(0, 200)}`);
        break;
      }
    }
    if (samples.length === 0) continue;
    const replayStart = performance.now();
    replay(DAY_PROJECT, events.slice(0, at));
    const bare = performance.now() - replayStart;
    const p95 = percentile(samples, 95);
    worstP95 = Math.max(worstP95, p95);
    const f = (n: number) => `${n.toFixed(1)} ms`;
    console.log(
      `| ${label} | ${at} | ${f(Math.min(...samples))} | ${f(median(samples))} | ${f(p95)} | ${f(Math.max(...samples))} | ${f(bare)} |`,
    );
  }
  console.log(
    `\nWorst p95 ${worstP95.toFixed(1)} ms against the ${TARGET_MS} ms target: ${worstP95 <= TARGET_MS ? "MET (checkpoints not needed)" : "MISSED (add checkpoints every 500 events)"}`,
  );
  engine.close();
} finally {
  rmSync(dir, { recursive: true, force: true });
}
process.exit(failed ? 1 : 0);
