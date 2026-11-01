import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Page, test } from "@playwright/test";
import { run } from "../../cli/src/main.ts";
import { CODES_FILE } from "./codes.ts";

// M3.13: celebrations (confetti, high-five, merge burst, Test Lab shimmer) play on the canvas when
// the seeded demo records the matching events. `?debug=celebrations` exposes a read-only probe,
// `window.__taskvilleCelebrations()`, returning the played celebrations in play order as
// `{ kind, at }[]` (`at` is performance.now() in ms). Screenshots for the PR land in
// E2E_SCREENSHOT_DIR (docs/tasks/M3.13/<kind>.png).

interface Played {
  kind: string;
  at: number;
}

const port = Number(process.env.E2E_PORT ?? 4817);
const codes = (): { celebrations: string; home: string } =>
  JSON.parse(readFileSync(CODES_FILE, "utf8"));
const pairingCode = (): string => codes().celebrations;

// One paired session for both tests (the pairing code is single use); the second test reloads it
// under reduced motion.
test.describe.configure({ mode: "serial" });

let page: Page;

test.beforeAll(async ({ browser }) => {
  page = await (await browser.newContext()).newPage();
});
test.afterAll(async () => {
  await page.context().close();
});

const played = (): Promise<Played[]> =>
  page.evaluate(() => {
    const probe = (window as unknown as { __taskvilleCelebrations?: () => Played[] })
      .__taskvilleCelebrations;
    if (typeof probe !== "function")
      throw new Error("window.__taskvilleCelebrations is not defined");
    return probe().map((p) => ({ kind: p.kind, at: p.at }));
  });

/** The probe installs a moment after the canvas shows (R3F children mount after the GL context). */
const probeReady = (): Promise<unknown> =>
  page.waitForFunction(
    () =>
      typeof (window as unknown as { __taskvilleCelebrations?: unknown })
        .__taskvilleCelebrations === "function",
    undefined,
    { timeout: 15_000 },
  );

/** Runs the seeded demo producer in process against the e2e engine; resolves when it finishes. */
async function runDemo(seed: number): Promise<void> {
  const out: string[] = [];
  const code = await run(
    [
      "demo",
      "start",
      "--project",
      "unsorted",
      "--seed",
      String(seed),
      "--speed",
      "120",
      "--duration",
      "60m",
      "--home",
      codes().home,
      "--url",
      `http://127.0.0.1:${port}`,
    ],
    {
      stdout: (t: string) => out.push(t),
      stderr: (t: string) => out.push(t),
      env: {},
      cwd: codes().home,
    },
  );
  expect(code, out.join("")).toBe(0);
}

// The particle colours Celebrations.tsx draws (PARTY and GOLD). They are unlit MeshBasicMaterial
// colours, so on screen they stay close to these values.
const EFFECT_COLORS = ["#ffd166", "#ef476f", "#06d6a0", "#118ab2", "#f78c6b", "#fff3b0"];

/** Fewer new palette pixels than this is "nothing drawn"; more is "a celebration drew". */
const MIN_NEW_PIXELS = 20;

/** A celebration must beat the quiet-frame control by at least this factor. */
const CONTROL_MARGIN = 3;

/** Per-channel tolerance for "this pixel is a palette colour now" (particles are unlit, exact). */
const TIGHT_TOLERANCE = 6;

/** RGB sum-of-differences tolerance for "this pixel already looked like a palette colour" (settled). */
const LOOSE_TOLERANCE = 45;

/** How long after a celebration starts its frames are copied, and how many, and how far apart. */
const CAPTURE_YOUNG_MS = 400;
const CAPTURE_MAX_FRAMES = 8;
const CAPTURE_SPACING_MS = 40;

/** A celebration lives at most 1.6 s; frames after that (and before the next) are "quiet". */
const QUIET_AFTER_MS = 1600;

interface Fresh {
  count: number;
  /** Up to 10 matched pixels, for diagnosing false positives. */
  samples: { x: number; y: number; rgb: string }[];
}

interface Measure {
  /** One entry per frame copied while the celebration played. */
  during: Fresh[];
  /** The latest quiet frame taken before the celebration, against the settled frame; null if none. */
  control: Fresh | null;
  /** Copies whose pixels are all transparent or black (a cleared drawing buffer). */
  blank: number;
  /** Frames whose size differs from the settled frame. */
  resized: number;
  /** Frames kept per celebration start time, and the longest pause between loop ticks (ms). */
  kept: string;
  /** Data URL of the during frame with the most new pixels, when asked for. */
  bestPng: string | null;
}

/**
 * Copies the WebGL canvas from inside the page. `canvas.screenshot()` takes 250 to 500 ms, which is
 * as long as a high-five lives (700 ms), so every screenshot showed an effect that had already
 * ended. Instead a requestAnimationFrame loop, registered after the scene's own render loop, copies
 * the canvas into a 2D canvas in the same frame the scene drew it (the drawing buffer is still
 * intact then, no preserveDrawingBuffer needed). It keeps:
 *   - up to CAPTURE_MAX_FRAMES frames per celebration, taken while it is younger than CAPTURE_YOUNG_MS;
 *   - "quiet" frames: taken at least QUIET_AFTER_MS after the latest probe entry, so no particle can
 *     be on screen (the control: scenery and agents move, nothing celebrates);
 *   - named snapshots on request (`snap`), used for the settled frame.
 * `measure` then counts, in the page, pixels that are tightly palette-coloured in a frame and were
 * not loosely palette-coloured at the same position in the settled frame.
 */
async function installCapture(): Promise<void> {
  await page.evaluate(
    ([palette, tight, loose, young, maxFrames, spacing, quietAfter]) => {
      interface Frame {
        data: ImageData;
        at: number;
      }
      interface Entry {
        kind: string;
        at: number;
      }
      const canvases = document.querySelectorAll("canvas");
      if (canvases.length !== 1) throw new Error(`expected one canvas, found ${canvases.length}`);
      const source = canvases[0] as HTMLCanvasElement;
      const flat = document.createElement("canvas");
      const ctx = flat.getContext("2d", { willReadFrequently: true });
      if (!ctx) throw new Error("no 2d context");
      const probe = () =>
        (window as unknown as { __taskvilleCelebrations: () => Entry[] }).__taskvilleCelebrations();

      const grab = (): Frame => {
        flat.width = source.width;
        flat.height = source.height;
        ctx.drawImage(source, 0, 0);
        return { data: ctx.getImageData(0, 0, flat.width, flat.height), at: performance.now() };
      };

      const duringFrames = new Map<number, Frame[]>();
      let quiet: Frame[] = [];
      const snaps = new Map<string, Frame>();
      const wanted: { name: string; done: () => void }[] = [];

      let ticks = 0;
      let lastTick = performance.now();
      let maxGap = 0;
      const tick = () => {
        const now = performance.now();
        ticks += 1;
        maxGap = Math.max(maxGap, now - lastTick);
        lastTick = now;
        const entries = probe();
        for (const e of entries) {
          if (now - e.at >= (young as number)) continue;
          const list = duringFrames.get(e.at) ?? [];
          const last = list[list.length - 1];
          if (
            list.length < (maxFrames as number) &&
            (!last || now - last.at >= (spacing as number))
          ) {
            list.push(grab());
            duringFrames.set(e.at, list);
          }
        }
        const latest = entries[entries.length - 1];
        const lastQuiet = quiet[quiet.length - 1];
        if (
          (!latest || now - latest.at >= (quietAfter as number)) &&
          (!lastQuiet || now - lastQuiet.at >= 500)
        ) {
          quiet.push(grab());
          if (quiet.length > 4) quiet = quiet.slice(-4);
        }
        for (const w of wanted.splice(0)) {
          snaps.set(w.name, grab());
          w.done();
        }
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);

      const colors = (palette as string[]).map((h) => [
        Number.parseInt(h.slice(1, 3), 16),
        Number.parseInt(h.slice(3, 5), 16),
        Number.parseInt(h.slice(5, 7), 16),
      ]);
      const diff = (d: Uint8ClampedArray, i: number, c: number[]) => [
        Math.abs((d[i] ?? 0) - (c[0] ?? 0)),
        Math.abs((d[i + 1] ?? 0) - (c[1] ?? 0)),
        Math.abs((d[i + 2] ?? 0) - (c[2] ?? 0)),
      ];
      const isTight = (d: Uint8ClampedArray, i: number) =>
        colors.some((c) => diff(d, i, c).every((v) => v <= (tight as number)));
      const isLoose = (d: Uint8ClampedArray, i: number) =>
        colors.some((c) => diff(d, i, c).reduce((a, v) => a + v, 0) <= (loose as number));
      const fresh = (p: ImageData, q: ImageData): Fresh => {
        let count = 0;
        const samples: Fresh["samples"] = [];
        for (let i = 0; i < p.data.length; i += 4) {
          if (isTight(p.data, i) && !isLoose(q.data, i)) {
            count += 1;
            if (samples.length < 10) {
              const px = i / 4;
              samples.push({
                x: px % p.width,
                y: Math.floor(px / p.width),
                rgb: `${p.data[i]},${p.data[i + 1]},${p.data[i + 2]}`,
              });
            }
          }
        }
        return { count, samples };
      };
      const isBlank = (f: ImageData) => {
        for (let i = 0; i < f.data.length; i += 4) {
          if ((f.data[i + 3] ?? 0) > 0 && (f.data[i] || f.data[i + 1] || f.data[i + 2]))
            return false;
        }
        return true;
      };
      const toPng = (f: ImageData) => {
        const c = document.createElement("canvas");
        c.width = f.width;
        c.height = f.height;
        c.getContext("2d")?.putImageData(f, 0, 0);
        return c.toDataURL("image/png");
      };

      (window as unknown as Record<string, unknown>).__tvCapture = {
        snap: (name: string) => new Promise<void>((done) => wanted.push({ name, done })),
        measure: (at: number, wantPng: boolean): Measure => {
          const settled = snaps.get("settled");
          if (!settled) throw new Error("no settled snapshot");
          const frames = duringFrames.get(at) ?? [];
          const during = frames.map((f) => fresh(f.data, settled.data));
          // The control frame must predate the celebration, so it cannot show its particles.
          const before = quiet.filter((f) => f.at <= at - 50);
          const q = before[before.length - 1];
          const best = during.reduce(
            (bi, d, i) => (d.count > (during[bi]?.count ?? -1) ? i : bi),
            0,
          );
          const all = [...frames, ...(q ? [q] : []), settled];
          return {
            during,
            control: q ? fresh(q.data, settled.data) : null,
            blank: all.filter((f) => isBlank(f.data)).length,
            resized: all.filter(
              (f) => f.data.width !== settled.data.width || f.data.height !== settled.data.height,
            ).length,
            kept: `${[...duringFrames].map(([k, v]) => `${k}:${v.length}`).join(" ")} ticks ${ticks} maxGap ${Math.round(maxGap)}ms asked ${at}`,
            bestPng: wantPng && frames[best] ? toPng(frames[best].data) : null,
          };
        },
      };
    },
    [
      EFFECT_COLORS,
      TIGHT_TOLERANCE,
      LOOSE_TOLERANCE,
      CAPTURE_YOUNG_MS,
      CAPTURE_MAX_FRAMES,
      CAPTURE_SPACING_MS,
      QUIET_AFTER_MS,
    ],
  );
}

test("the demo plays confetti or a high-five, spaced at least 2 s apart, and it shows on the canvas", async () => {
  test.setTimeout(120_000);
  // Pair first (the code is single use), then open the debug view in the same session.
  await page.goto(`/#pair=${pairingCode()}`);
  await expect(page.getByTestId("scene-root")).toBeVisible();
  await page.goto("/?debug=celebrations");
  await expect(page.getByTestId("scene-root")).toBeVisible();
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();

  // The probe exists and nothing has played yet.
  await probeReady();
  await expect.poll(() => played(), { timeout: 15_000 }).toEqual([]);
  await page.waitForTimeout(1500); // let the first WebGL frames draw
  await installCapture(); // copies frames inside the page from here on

  // The demo runs for ~30 s of real time; do not wait for it, watch the probe while it runs.
  const demo = runDemo(7);

  // The first confetti pop or high-five; its frames are copied in the page as it plays.
  const seen = await page.waitForFunction(
    () => {
      const probe = (window as unknown as { __taskvilleCelebrations?: () => Played[] })
        .__taskvilleCelebrations;
      const hit = probe?.().find((p) => p.kind === "confetti" || p.kind === "high-five");
      return hit ? { kind: hit.kind, at: hit.at } : false;
    },
    undefined,
    { polling: 30, timeout: 90_000 },
  );
  const { kind, at } = (await seen.jsonValue()) as Played;

  // The same scene once the effect is over (confetti lives 1.2 s; the next burst is >= 2 s away).
  await page.waitForFunction((t) => performance.now() - t >= 1600, at, { polling: 50 });
  await page.evaluate(() =>
    (window as unknown as { __tvCapture: { snap(n: string): Promise<void> } }).__tvCapture.snap(
      "settled",
    ),
  );

  const dir = process.env.E2E_SCREENSHOT_DIR;
  const m = await page.evaluate(
    ([t, png]) =>
      (
        window as unknown as { __tvCapture: { measure(a: number, p: boolean): Measure } }
      ).__tvCapture.measure(t as number, png as boolean),
    [at, Boolean(dir)] as const,
  );
  const counts = m.during.map((d) => d.count);
  const fresh = Math.max(0, ...counts);
  const control = m.control;
  const summary = `kept [${m.kept}]; during per frame ${counts.join(", ")} (best ${fresh}), settled is the reference, control ${control ? control.count : "none"}, threshold ${MIN_NEW_PIXELS}, margin x${CONTROL_MARGIN}`;
  console.log(`celebrations e2e: ${kind} ${summary}`);

  // The copies must be real: a cleared drawing buffer reads back blank, and then nothing below
  // means anything. If this fails the capture needs a source seam; do not loosen the checks.
  expect(m.blank, `in-page canvas copies are blank (drawing buffer cleared); ${summary}`).toBe(0);
  expect(m.resized, `canvas size is stable across frames; ${summary}`).toBe(0);
  expect(counts.length, `frames were copied while ${kind} played; ${summary}`).toBeGreaterThan(0);
  if (!control)
    throw new Error(`no quiet frame before the celebration for the control; ${summary}`);

  if (dir && m.bestPng) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${kind}.png`, Buffer.from(m.bestPng.split(",")[1] as string, "base64"));
  }

  // Negative control: two frames with no particle on screen, a celebration's length apart, with
  // the same matcher. Scenery and agent movement must stay under the threshold.
  if (control.count >= MIN_NEW_PIXELS) {
    console.log(
      `celebrations e2e: control false-positive samples ${JSON.stringify(control.samples)}`,
    );
  }
  expect(
    control.count,
    `no celebration drawn: palette pixels between two quiet frames; ${summary}`,
  ).toBeLessThan(MIN_NEW_PIXELS);
  expect(
    fresh,
    `${kind} particles are visible on the canvas while it plays; ${summary}`,
  ).toBeGreaterThan(MIN_NEW_PIXELS);
  expect(
    fresh,
    `${kind} particles clearly exceed the control (>= max(${MIN_NEW_PIXELS}, ${CONTROL_MARGIN} x control)); ${summary}`,
  ).toBeGreaterThanOrEqual(Math.max(MIN_NEW_PIXELS, CONTROL_MARGIN * control.count));

  await demo;
  const all = await played();
  expect(all.some((p) => p.kind === "confetti" || p.kind === "high-five")).toBe(true);
  for (const p of all) expect(p.kind).not.toBe("sparkle");
  for (let i = 1; i < all.length; i++) {
    const gap = (all[i] as Played).at - (all[i - 1] as Played).at;
    expect(gap, `celebration ${i} followed the previous one too soon`).toBeGreaterThanOrEqual(2000);
  }
});

test("with reduced motion every celebration is a sparkle", async () => {
  test.setTimeout(120_000);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/?debug=celebrations"); // same paired session, fresh page load
  await expect(page.getByTestId("scene-root")).toBeVisible();
  await probeReady();
  await expect.poll(() => played(), { timeout: 15_000 }).toEqual([]);

  // A different seed: the first demo's events are already recorded and must not be deduplicated.
  const demo = runDemo(8);
  await expect.poll(async () => (await played()).length, { timeout: 90_000 }).toBeGreaterThan(0);
  await demo;

  const all = await played();
  expect(all.length).toBeGreaterThan(0);
  expect(all.map((p) => p.kind)).toEqual(all.map(() => "sparkle"));
});
