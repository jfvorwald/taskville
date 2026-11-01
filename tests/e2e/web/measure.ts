// M3.16 measurement (NOT a test, asserts nothing): frames per second with six demo agents moving,
// and browser CPU once they have settled. It prints numbers against the ARCHITECTURE.md section 11
// budget (60 fps moving, under 5% CPU idle, 20 fps when nothing moves) and always exits 0 unless
// it could not measure. Run it only on purpose, with the machine otherwise quiet:
//
//   pnpm --filter @taskville/web build
//   node tests/e2e/web/measure.ts [--headed] [--moving 10] [--settle 8] [--idle 10] [--port 4886]
//
// It starts its own engine (apps/web/e2e/engine.ts, pairing code `web`) and Chromium, pairs, runs
// the seeded demo, then samples. Headless Chromium uses software GL (SwiftShader), so the fps is a
// worst case, not an integrated GPU figure; pass --headed on the target machine for that.
import { type ChildProcess, spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "./playwright.ts";
import { runDemo, webCodes } from "./support.ts";

const flag = (name: string, fallback: number): number => {
  const at = process.argv.indexOf(`--${name}`);
  const value = at >= 0 ? Number(process.argv[at + 1]) : fallback;
  if (!Number.isFinite(value) || value <= 0) throw new Error(`--${name} needs a positive number`);
  return value;
};
const headed = process.argv.includes("--headed");
const movingSeconds = flag("moving", 10);
const settleSeconds = flag("settle", 8);
const idleSeconds = flag("idle", 10);
const port = String(flag("port", 4886));
const web = fileURLToPath(new URL("../../../apps/web", import.meta.url));

const BUDGET = { movingFps: 60, idleCpuPercent: 5, idleFps: 20 };

async function startEngine(): Promise<ChildProcess> {
  const engine = spawn("node", ["e2e/engine.ts"], {
    cwd: web,
    env: { ...process.env, E2E_PORT: port, E2E_SPEC: "web" },
    stdio: ["ignore", "pipe", "inherit"],
  });
  await new Promise<void>((resolve, reject) => {
    engine.once("exit", (code) => reject(new Error(`engine exited early (${code})`)));
    engine.stdout?.on("data", (chunk: Buffer) => {
      if (chunk.toString().includes("listening")) resolve();
    });
  });
  return engine;
}

interface Fps {
  fps: number;
  frames: number;
  worstFrameMs: number;
  p95FrameMs: number;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const engine = await startEngine();
const browser = await chromium.launch({
  headless: !headed,
  args: headed ? [] : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
});
try {
  const { web: code, home } = webCodes();
  const context = await browser.newContext({
    baseURL: `http://127.0.0.1:${port}`,
    viewport: { width: 1280, height: 720 },
  });
  // A rendered-frame counter. A frame counts when WebGL drew at least once since the last
  // animation frame, so an idle loop that throttles itself shows its real rate (a bare
  // requestAnimationFrame counter would read the browser's 60 Hz whatever the app does).
  await context.addInitScript(() => {
    const w = window as unknown as { __tvFrames: number[] };
    w.__tvFrames = [];
    let drew = false;
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      for (const name of [
        "drawElements",
        "drawArrays",
        "drawElementsInstanced",
        "drawArraysInstanced",
      ] as const) {
        const original = proto[name] as (...args: unknown[]) => void;
        (proto as unknown as Record<string, unknown>)[name] = function (...args: unknown[]) {
          drew = true;
          return original.apply(this, args);
        };
      }
    }
    const tick = (t: number) => {
      if (drew) {
        w.__tvFrames.push(t);
        drew = false;
      }
      requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  const page = await context.newPage();
  await page.goto(`/#pair=${code}`);
  await page.getByTestId("scene-root").waitFor({ timeout: 20_000 });

  const sampleFps = async (seconds: number): Promise<Fps> => {
    await page.evaluate(() => {
      (window as unknown as { __tvFrames: number[] }).__tvFrames.length = 0;
    });
    await sleep(seconds * 1000);
    const times = await page.evaluate(() =>
      (window as unknown as { __tvFrames: number[] }).__tvFrames.slice(),
    );
    const gaps = times.slice(1).map((t, i) => t - (times[i] ?? t));
    const sorted = [...gaps].sort((a, b) => a - b);
    const span = (times.at(-1) ?? 0) - (times[0] ?? 0);
    return {
      fps: span > 0 ? (times.length - 1) / (span / 1000) : 0,
      frames: times.length,
      worstFrameMs: sorted.at(-1) ?? 0,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
    };
  };

  // CPU of the whole browser (every process, GPU included) over a window, as a percentage of one
  // core, from the CDP SystemInfo.getProcessInfo cumulative CPU times.
  const cdp = await browser.newBrowserCDPSession();
  const cpuSeconds = async (): Promise<number> => {
    const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as {
      processInfo: { cpuTime: number }[];
    };
    return processInfo.reduce((sum, p) => sum + p.cpuTime, 0);
  };
  const sampleCpu = async (seconds: number): Promise<number> => {
    const [c0, t0] = [await cpuSeconds(), performance.now()];
    await sleep(seconds * 1000);
    const [c1, t1] = [await cpuSeconds(), performance.now()];
    return ((c1 - c0) / ((t1 - t0) / 1000)) * 100;
  };

  // Moving: the demo runs long enough to cover the window plus its start-up; sample from the
  // moment all six agents are in the city.
  const stop = new AbortController();
  const demo = runDemo(home, {
    duration: "120m",
    speed: 120,
    port: Number(port),
    signal: stop.signal,
  });
  const labels = page.getByTestId("agent-label");
  await labels.nth(5).waitFor({ timeout: 30_000 });
  const movingCpuPromise = sampleCpu(movingSeconds);
  const moving = await sampleFps(movingSeconds);
  const movingCpu = await movingCpuPromise;

  // Idle: stop the producer, give the agents time to reach their slots and the loop time to drop
  // its frame rate, then sample.
  stop.abort();
  await demo;
  await sleep(settleSeconds * 1000);
  const idleCpuPromise = sampleCpu(idleSeconds);
  const idle = await sampleFps(idleSeconds);
  const idleCpu = await idleCpuPromise;

  const agents = await labels.count();
  const f = (n: number, d = 1) => n.toFixed(d);
  const verdict = (ok: boolean) => (ok ? "within budget" : "BELOW BUDGET");
  console.log(`# Taskville web performance (${new Date().toISOString()})`);
  console.log(
    `Chromium ${browser.version()} ${headed ? "headed (real GPU)" : "headless (software GL, worst case)"}, 1280x720, ${agents} agent labels, Node ${process.version}`,
  );
  console.log(`\nMoving (${movingSeconds} s, demo seed 7 at 120x):`);
  console.log(
    `  fps ${f(moving.fps)} (budget ${BUDGET.movingFps}): ${verdict(moving.fps >= BUDGET.movingFps * 0.95)}`,
  );
  console.log(`  frame time p95 ${f(moving.p95FrameMs)} ms, worst ${f(moving.worstFrameMs)} ms`);
  console.log(`  browser CPU ${f(movingCpu)}% of one core`);
  console.log(`\nIdle (${idleSeconds} s after ${settleSeconds} s settle):`);
  console.log(
    `  fps ${f(idle.fps)} (budget about ${BUDGET.idleFps} when nothing moves): ${verdict(idle.fps <= BUDGET.idleFps * 1.5)}`,
  );
  console.log(
    `  browser CPU ${f(idleCpu)}% of one core (budget under ${BUDGET.idleCpuPercent}%): ${verdict(idleCpu < BUDGET.idleCpuPercent)}`,
  );
} finally {
  await browser.close().catch(() => {});
  engine.kill("SIGTERM");
}
