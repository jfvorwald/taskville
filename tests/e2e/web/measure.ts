// M3.16 measurement (NOT a test, asserts nothing): frames per second with six demo agents moving,
// and browser CPU once they have settled. It prints numbers against the ARCHITECTURE.md section 11
// budget (60 fps moving, under 5% CPU idle, 20 fps when nothing moves) and always exits 0 unless
// it could not measure. Run it only on purpose, with the machine otherwise quiet:
//
//   pnpm --filter @taskville/web build
//   node tests/e2e/web/measure.ts [--headed] [--moving 10] [--settle 8] [--idle 10] [--dpr 1] [--port 4886]
//
// It starts its own engine (apps/web/e2e/engine.ts, pairing code `web`) and Chromium, pairs, runs
// the seeded demo, then samples. Headless Chromium uses software GL (SwiftShader), so the fps is a
// worst case, not an integrated GPU figure; pass --headed on the target machine for that. In a
// headed run keep the real pointer off the browser window, or hovering an agent redraws the scene.
import { type ChildProcess, execFileSync, spawn } from "node:child_process";
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
const dpr = flag("dpr", 1);
const port = String(flag("port", 4886));
const web = fileURLToPath(new URL("../../../apps/web", import.meta.url));

// macOS proc_pid_rusage(RUSAGE_INFO_V4) for the pids given as arguments; prints JSON
// {pid: [instructions, cycles, cpu_ns]}. user and system time are mach absolute ticks, so they are
// scaled by mach_timebase_info (about 41.7 ns per tick on Apple Silicon); unscaled, GHz is 42x off.
const RUSAGE_PY = `
import ctypes, json, sys
lib = ctypes.CDLL("/usr/lib/libproc.dylib")
class TB(ctypes.Structure):
    _fields_ = [("n", ctypes.c_uint32), ("d", ctypes.c_uint32)]
tb = TB()
ctypes.CDLL("/usr/lib/libSystem.B.dylib").mach_timebase_info(ctypes.byref(tb))
names = "user_time system_time pkg_idle_wkups interrupt_wkups pageins wired_size resident_size phys_footprint proc_start_abstime proc_exit_abstime child_user_time child_system_time child_pkg_idle_wkups child_interrupt_wkups child_pageins child_elapsed_abstime diskio_bytesread diskio_byteswritten cpu_time_qos_default cpu_time_qos_maintenance cpu_time_qos_background cpu_time_qos_utility cpu_time_qos_legacy cpu_time_qos_user_initiated cpu_time_qos_user_interactive billed_system_time serviced_system_time logical_writes lifetime_max_phys_footprint instructions cycles billed_energy serviced_energy interval_max_phys_footprint runnable_time".split()
class V4(ctypes.Structure):
    _fields_ = [("uuid", ctypes.c_uint8 * 16)] + [(n, ctypes.c_uint64) for n in names]
out = {}
for pid in sys.argv[1:]:
    b = V4()
    if lib.proc_pid_rusage(int(pid), 4, ctypes.byref(b)) == 0:
        out[pid] = [b.instructions, b.cycles, (b.user_time + b.system_time) * tb.n // tb.d]
print(json.dumps(out))
`;

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
  /** Frames in the busiest one second of the window (WebGL `clear` calls). */
  busiestSecond: number;
  /** Raw requestAnimationFrame callbacks per second; null when the window ran no counter. */
  rafRate: number | null;
  /** Display refresh estimate: 1000 / the 10th percentile rAF gap; null with no counter. */
  refreshHz: number | null;
}

/** States in which an agent is still travelling (see PresentationState in the city's navigator). */
const TRAVELLING = new Set(["arriving", "walking", "departing"]);

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const engine = await startEngine();
// Aborted in finally, so a failure after the demo starts still stops its producer (roborev 5742).
const stop = new AbortController();
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
    deviceScaleFactor: dpr,
  });
  // A rendered-frame counter: every WebGL `clear` call is one drawn frame (three.js clears once per
  // render), so an idle loop that throttles itself shows its real rate and the counter needs no
  // requestAnimationFrame loop of its own. A separate requestAnimationFrame counter exists only
  // for the moving window and is switched off for the idle window: it would hold Blink at 60 Hz
  // and inflate the idle CPU. Frames are timestamped with performance.now().
  await context.addInitScript(() => {
    const w = window as unknown as {
      __tvFrames: number[];
      __tvRaf: number[];
      __tvRafOn: (on: boolean) => void;
    };
    w.__tvFrames = [];
    w.__tvRaf = [];
    for (const proto of [WebGLRenderingContext.prototype, WebGL2RenderingContext.prototype]) {
      const original = proto.clear as (...args: unknown[]) => void;
      (proto as unknown as Record<string, unknown>).clear = function (...args: unknown[]) {
        w.__tvFrames.push(performance.now());
        return original.apply(this, args);
      };
    }
    let running = false;
    const tick = (t: number) => {
      if (!running) return;
      w.__tvRaf.push(t);
      requestAnimationFrame(tick);
    };
    w.__tvRafOn = (on: boolean) => {
      if (on && !running) {
        running = true;
        requestAnimationFrame(tick);
      }
      running = on;
    };
  });
  const page = await context.newPage();
  await page.goto(`/#pair=${code}`);
  await page.getByTestId("scene-root").waitFor({ timeout: 20_000 });

  /** `withRaf` runs the requestAnimationFrame counter for the window; the idle window passes false. */
  const sampleFps = async (seconds: number, withRaf: boolean): Promise<Fps> => {
    const startedAt = await page.evaluate((on) => {
      const w = window as unknown as {
        __tvFrames: number[];
        __tvRaf: number[];
        __tvRafOn: (on: boolean) => void;
      };
      w.__tvFrames.length = 0;
      w.__tvRaf.length = 0;
      w.__tvRafOn(on);
      return performance.now();
    }, withRaf);
    await sleep(seconds * 1000);
    const { times, raf, endedAt } = await page.evaluate(() => {
      const w = window as unknown as {
        __tvFrames: number[];
        __tvRaf: number[];
        __tvRafOn: (on: boolean) => void;
      };
      w.__tvRafOn(false);
      return { times: w.__tvFrames.slice(), raf: w.__tvRaf.slice(), endedAt: performance.now() };
    });
    const gapsOf = (ts: number[]) => ts.slice(1).map((t, i) => t - (ts[i] ?? t));
    // Frames over the whole window as the page measured it (reset to read), so a burst followed
    // by a stall cannot read as a high rate, and a late read does not inflate it (roborev 5726,
    // 5728, 5733).
    const elapsedSeconds = (endedAt - startedAt) / 1000;
    const rate = (ts: number[]) => (elapsedSeconds > 0 ? ts.length / elapsedSeconds : 0);
    // The window's edges count as frame boundaries, so a stall before the first or after the last
    // drawn frame shows in the frame times (roborev 5738).
    const sorted = gapsOf([startedAt, ...times, endedAt]).sort((a, b) => a - b);
    const rafGaps = gapsOf(raf).sort((a, b) => a - b);
    const fastGap = rafGaps[Math.floor(rafGaps.length * 0.1)] ?? 0;
    // The most frames in any one second of the window: a full-rate segment (for example the second
    // after a pointer event) shows here even when the window's average looks low.
    let busiestSecond = 0;
    for (let i = 0, j = 0; i < times.length; i++) {
      while ((times[i] ?? 0) - (times[j] ?? 0) >= 1000) j++;
      busiestSecond = Math.max(busiestSecond, i - j + 1);
    }
    return {
      busiestSecond,
      fps: rate(times),
      frames: times.length,
      worstFrameMs: sorted.at(-1) ?? 0,
      p95FrameMs: sorted[Math.floor(sorted.length * 0.95)] ?? 0,
      rafRate: withRaf ? rate(raf) : null,
      refreshHz: withRaf && fastGap > 0 ? 1000 / fastGap : null,
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
  // Retired instructions, cycles and CPU time per Chromium process (macOS only; null elsewhere or on
  // any failure), read for the same pids the CDP call returns.
  interface Usage {
    at: number;
    procs: Map<string, { type: string; instructions: number; cycles: number; ns: number }>;
  }
  const usage = async (): Promise<Usage | null> => {
    if (process.platform !== "darwin") return null;
    try {
      const { processInfo } = (await cdp.send("SystemInfo.getProcessInfo")) as {
        processInfo: { type: string; id: number }[];
      };
      const out = execFileSync(
        "python3",
        ["-I", "-c", RUSAGE_PY, ...processInfo.map((p) => String(p.id))],
        { encoding: "utf8", timeout: 10_000 },
      );
      const raw = JSON.parse(out) as Record<string, [number, number, number]>;
      const procs: Usage["procs"] = new Map();
      for (const p of processInfo) {
        const r = raw[String(p.id)];
        if (r)
          procs.set(String(p.id), { type: p.type, instructions: r[0], cycles: r[1], ns: r[2] });
      }
      return procs.size > 0 ? { at: performance.now(), procs } : null;
    } catch {
      return null;
    }
  };
  const sampleCpu = async (seconds: number): Promise<number> => {
    const [c0, t0] = [await cpuSeconds(), performance.now()];
    await sleep(seconds * 1000);
    const [c1, t1] = [await cpuSeconds(), performance.now()];
    return ((c1 - c0) / ((t1 - t0) / 1000)) * 100;
  };

  // Moving: the demo runs long enough to cover the window plus its start-up; sample from the
  // moment all six agents are in the city.
  let demoEnded: { code: number; output: string } | null = null;
  const demo = runDemo(home, {
    // At 120x one real second is two simulated minutes, so size the demo to
    // the window plus start-up and settle margin, whatever --moving is (roborev 5738).
    duration: `${Math.ceil(((movingSeconds + 30) * 120) / 60)}m`,
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
  const movingUsage0 = await usage();
  const movingCpuPromise = sampleCpu(movingSeconds);
  const moving = await sampleFps(movingSeconds, true);
  const movingCpu = await movingCpuPromise;
  const movingUsage1 = await usage();
  demoMustRun("during the moving window, so the moving figures are not all moving");
  const movingNow = await travelling();

  // Idle: stop the producer, give the agents time to reach their slots and the loop time to drop
  // its frame rate, then check they really are still before sampling.
  stop.abort();
  const demoExit = await demo;
  // Park the pointer before the settle, not just before the window: a pointer event holds the idle
  // throttle at full rate for one second, so it must be over long before the window opens.
  await parkPointer();
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
  // Check the labels just before and just after the idle window, not during it: polling the page
  // while sampling would add renderer work to the measured idle CPU (roborev 5742).
  const moversBefore = (await travelling()).moving;
  const idleUsage0 = await usage();
  const idleCpuPromise = sampleCpu(idleSeconds);
  const idle = await sampleFps(idleSeconds, false);
  const idleCpu = await idleCpuPromise;
  const idleUsage1 = await usage();
  const moversAfter = (await travelling()).moving;

  const agents = await labels.count();
  const f = (n: number, d = 1) => n.toFixed(d);
  /** Measured against a target, as a plain difference in percent. */
  const against = (measured: number, target: number, what: string) => {
    const pct = ((measured - target) / target) * 100;
    if (Math.abs(pct) < 0.05) return `exactly the ${what}`;
    return `${f(Math.abs(pct))}% ${pct > 0 ? "above" : "below"} the ${what}`;
  };
  /** Per process type and in total: instructions retired in the window, and cycles per CPU ns (GHz). */
  const instructionLines = (a: Usage | null, b: Usage | null): string => {
    if (!a || !b) return "  instructions: unavailable";
    const seconds = (b.at - a.at) / 1000;
    const byType = new Map<string, { instructions: number; cycles: number; ns: number }>();
    const missing = new Set<string>();
    let started = 0;
    let exited = 0;
    for (const [pid, start] of a.procs) {
      if (b.procs.has(pid)) continue;
      exited++; // gone by the end snapshot: its final work is not readable
      missing.add(start.type);
    }
    for (const [pid, end] of b.procs) {
      const start = a.procs.get(pid);
      if (!start) {
        started++; // started inside the window: no baseline
        missing.add(end.type);
        continue;
      }
      const sum = byType.get(end.type) ?? { instructions: 0, cycles: 0, ns: 0 };
      sum.instructions += end.instructions - start.instructions;
      sum.cycles += end.cycles - start.cycles;
      sum.ns += end.ns - start.ns;
      byType.set(end.type, sum);
    }
    if (byType.size === 0 || seconds <= 0) return "  instructions: unavailable";
    const total = { instructions: 0, cycles: 0, ns: 0 };
    for (const sum of byType.values()) {
      total.instructions += sum.instructions;
      total.cycles += sum.cycles;
      total.ns += sum.ns;
    }
    const line = (type: string, s: typeof total) =>
      `  instructions ${type}: ${s.instructions} ${f(s.instructions / seconds / 1e6, 0)} M/s, effective ${s.ns > 0 ? f(s.cycles / s.ns, 2) : "n/a"} GHz`;
    const label =
      started + exited === 0
        ? "total"
        : `total (incomplete: ${started} started, ${exited} exited; missing ${[...missing].join(", ")})`;
    return [...byType]
      .map(([type, s]) => line(type, s))
      .concat(line(label, total))
      .join("\n");
  };
  const rates = (r: Fps) =>
    `${r.rafRate === null ? "  no requestAnimationFrame counter in this window" : `  requestAnimationFrame ${f(r.rafRate)}/s, display refresh estimate ${f(r.refreshHz ?? 0, 0)} Hz`}\n  frames counted from WebGL clear: ${r.frames} (${f(r.fps)} fps), busiest second ${r.busiestSecond} frames`;
  console.log(`# Taskville web performance (${new Date().toISOString()})`);
  console.log(
    `Chromium ${browser.version()} ${headed ? "headed (real GPU)" : "headless (software GL, worst case)"}, 1280x720 at dpr ${dpr}, ${agents} agent labels, Node ${process.version}`,
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
  console.log(instructionLines(movingUsage0, movingUsage1));
  console.log(`\nIdle (${idleSeconds} s after ${settleSeconds} s settle):`);
  console.log(
    `  agents travelling at the start and end of the idle window: ${moversBefore} and ${moversAfter}${moversBefore + moversAfter === 0 ? " (still)" : " (NOT STILL)"}`,
  );
  console.log(
    `  fps ${f(idle.fps)}, target ${BUDGET.idleFps}: ${against(idle.fps, BUDGET.idleFps, "idle target")}`,
  );
  console.log(rates(idle));
  console.log(
    `  browser CPU ${f(idleCpu)}% of one core, target under ${BUDGET.idleCpuPercent}%: ${against(idleCpu, BUDGET.idleCpuPercent, "idle target")}`,
  );
  console.log(instructionLines(idleUsage0, idleUsage1));
} finally {
  stop.abort();
  await browser?.close().catch(() => {});
  engine.kill("SIGTERM");
}
