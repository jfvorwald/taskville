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
// worst case, not an integrated GPU figure; pass --headed on the target machine for that. In a
// headed run keep the real pointer off the browser window, or hovering an agent redraws the scene.
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
  /** Raw requestAnimationFrame callbacks per second, whether or not the scene drew. */
  rafRate: number;
  /** Display refresh estimate: 1000 / the 10th percentile rAF gap (a throttled window reads low). */
  refreshHz: number;
}

/** States in which an agent is still travelling (see PresentationState in the city's navigator). */
const TRAVELLING = new Set(["arriving", "walking", "departing"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const engine = await startEngine();
let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
try {
  // Launched inside the try, so a failed launch still stops the engine (roborev 5720, 5733).
  browser = await chromium.launch({
    headless: !headed,
    args: headed
      ? []
      : ["--use-gl=angle", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"],
  });
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
    const raf: number[] = [];
    (window as unknown as { __tvRaf: number[] }).__tvRaf = raf;
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
      raf.push(t);
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
    const startedAt = await page.evaluate(() => {
      const w = window as unknown as { __tvFrames: number[]; __tvRaf: number[] };
      w.__tvFrames.length = 0;
      w.__tvRaf.length = 0;
      return performance.now();
    });
    await sleep(seconds * 1000);
    const { times, raf, endedAt } = await page.evaluate(() => {
      const w = window as unknown as { __tvFrames: number[]; __tvRaf: number[] };
      return { times: w.__tvFrames.slice(), raf: w.__tvRaf.slice(), endedAt: performance.now() };
    });
    const gapsOf = (ts: number[]) => ts.slice(1).map((t, i) => t - (ts[i] ?? t));
    // Frames over the whole window as the page measured it (reset to read), so a burst followed
    // by a stall cannot read as a high rate, and a late read does not inflate it (roborev 5726,
    // 5728, 5733).
    const elapsedSeconds = (endedAt - startedAt) / 1000;
    const rate = (ts: number[]) => (elapsedSeconds > 0 ? ts.length / elapsedSeconds : 0);
    const sorted = gapsOf(times).sort((a, b) => a - b);
    const rafGaps = gapsOf(raf).sort((a, b) => a - b);
    const fastGap = rafGaps[Math.floor(rafGaps.length * 0.1)] ?? 0;
    return {
      fps: rate(times),
      frames: times.length,
      worstFrameMs: sorted.at(-1) ?? 0,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      rafRate: rate(raf),
      refreshHz: fastGap > 0 ? 1000 / fastGap : 0,
    };
  };

  /** The agent labels' states right now: how many agents are travelling, and how many there are. */
  const travelling = async (): Promise<{ moving: number; total: number }> => {
    const states = await page
      .getByTestId("agent-label")
      .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.state ?? ""));
    return { moving: states.filter((st) => TRAVELLING.has(st)).length, total: states.length };
  };

  // Park the pointer in the page corner, where no agent stands, so a hover cannot redraw the scene.
  // (This moves Playwright's pointer only; in a headed run keep the real pointer off the window.)
  const parkPointer = () => page.mouse.move(0, 0);

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
  let demoEnded: { code: number; output: string } | null = null;
  const demo = runDemo(home, {
    duration: "120m",
    speed: 120,
    port: Number(port),
    signal: stop.signal,
  }).then((result) => {
    demoEnded = result;
    return result;
  });
  const demoMustRun = (when: string) => {
    if (demoEnded !== null) {
      const { code, output } = demoEnded as { code: number; output: string };
      throw new Error(`demo producer ended ${when} (exit ${code}); output:\n${output}`);
    }
  };
  const labels = page.getByTestId("agent-label");
  await labels.nth(5).waitFor({ timeout: 30_000 });
  demoMustRun("before the moving window");
  await parkPointer();
  const movingCpuPromise = sampleCpu(movingSeconds);
  const moving = await sampleFps(movingSeconds);
  const movingCpu = await movingCpuPromise;
  demoMustRun("during the moving window, so the moving figures are not all moving");
  const movingNow = await travelling();

  // Idle: stop the producer, give the agents time to reach their slots and the loop time to drop
  // its frame rate, then check they really are still before sampling.
  stop.abort();
  const demoExit = await demo;
  await sleep(settleSeconds * 1000);
  let stillSince = Date.now();
  const stillDeadline = Date.now() + 60_000;
  while (Date.now() - stillSince < 2000) {
    if ((await travelling()).moving > 0) stillSince = Date.now();
    if (Date.now() > stillDeadline) {
      throw new Error("agents were still travelling 60 s after the producer stopped; not idle");
    }
    await sleep(250);
  }
  await parkPointer();
  // Watch the labels through the idle window, so a late mover shows up in the report.
  let polls = 0;
  let pollsWithMovers = 0;
  let watching = true;
  const watcher = (async () => {
    while (watching) {
      polls++;
      if ((await travelling()).moving > 0) pollsWithMovers++;
      await sleep(250);
    }
  })();
  const idleCpuPromise = sampleCpu(idleSeconds);
  const idle = await sampleFps(idleSeconds);
  const idleCpu = await idleCpuPromise;
  watching = false;
  await watcher;

  const agents = await labels.count();
  const f = (n: number, d = 1) => n.toFixed(d);
  /** Measured against a target, as a plain difference in percent. */
  const against = (measured: number, target: number, what: string) => {
    const pct = ((measured - target) / target) * 100;
    if (Math.abs(pct) < 0.05) return `exactly the ${what}`;
    return `${f(Math.abs(pct))}% ${pct > 0 ? "above" : "below"} the ${what}`;
  };
  const rates = (r: Fps) =>
    `  requestAnimationFrame ${f(r.rafRate)}/s, display refresh estimate ${f(r.refreshHz, 0)} Hz (rendered ${f(r.fps)} fps; ${r.frames} frames drawn)`;
  console.log(`# Taskville web performance (${new Date().toISOString()})`);
  console.log(
    `Chromium ${browser.version()} ${headed ? "headed (real GPU)" : "headless (software GL, worst case)"}, 1280x720, ${agents} agent labels, Node ${process.version}`,
  );
  if (headed) console.log("Note: keep the real pointer off the browser window while it samples.");
  console.log(
    `Demo producer: ran through the moving window; exited ${demoExit.code} when stopped.`,
  );
  console.log(
    `\nMoving (${movingSeconds} s, demo seed 7 at 120x; ${movingNow.moving} of ${movingNow.total} agents travelling at the end):`,
  );
  console.log(
    `  fps ${f(moving.fps)}, target ${BUDGET.movingFps}: ${against(moving.fps, BUDGET.movingFps, "moving target")}`,
  );
  console.log(rates(moving));
  console.log(`  frame time p95 ${f(moving.p95FrameMs)} ms, worst ${f(moving.worstFrameMs)} ms`);
  console.log(`  browser CPU ${f(movingCpu)}% of one core (no moving CPU target)`);
  console.log(`\nIdle (${idleSeconds} s after ${settleSeconds} s settle):`);
  console.log(
    `  agents moved during the idle window: ${pollsWithMovers === 0 ? "no" : "YES"} (${pollsWithMovers} of ${polls} label polls saw a travelling agent)`,
  );
  console.log(
    `  fps ${f(idle.fps)}, target ${BUDGET.idleFps}: ${against(idle.fps, BUDGET.idleFps, "idle target")}`,
  );
  console.log(rates(idle));
  console.log(
    `  browser CPU ${f(idleCpu)}% of one core, target under ${BUDGET.idleCpuPercent}%: ${against(idleCpu, BUDGET.idleCpuPercent, "idle target")}`,
  );
} finally {
  await browser?.close().catch(() => {});
  engine.kill("SIGTERM");
}
