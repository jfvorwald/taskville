import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
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

interface Fresh {
  count: number;
  /** Up to 10 matched pixels, for diagnosing false positives. */
  samples: { x: number; y: number; rgb: string }[];
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(png: Buffer): { width: number; height: number } {
  return { width: png.readUInt32BE(16), height: png.readUInt32BE(20) };
}

/**
 * Pixels that are tightly effect-coloured in `during` (each channel within TIGHT_TOLERANCE of a
 * palette colour) and were not loosely palette-coloured (RGB sum within LOOSE_TOLERANCE) at the same
 * position in `settled`, counted in the browser. `settled` is the same canvas after the celebration
 * ended, so agents and scenery are already drawn in both frames and only the particles are new.
 */
async function newEffectPixels(during: Buffer, settled: Buffer): Promise<Fresh> {
  return page.evaluate(
    async ([x, y, palette, tight, loose]) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const ctx = c.getContext("2d");
        if (!ctx) throw new Error("no 2d context");
        ctx.drawImage(img, 0, 0);
        return ctx.getImageData(0, 0, c.width, c.height);
      };
      const [p, q] = [await load(x as string), await load(y as string)];
      if (p.width !== q.width || p.height !== q.height) throw new Error("frame sizes differ");
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
      let count = 0;
      const samples: { x: number; y: number; rgb: string }[] = [];
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
    },
    [
      during.toString("base64"),
      settled.toString("base64"),
      EFFECT_COLORS,
      TIGHT_TOLERANCE,
      LOOSE_TOLERANCE,
    ],
  );
}

/**
 * Negative control for `newEffectPixels`: two canvas frames with no celebration drawn in between,
 * taken while the demo is still running so agents keep moving. A celebration lives at most 1.6 s and
 * the next is at least 2 s after the last started, so the quiet window opens 1.6 s after the latest
 * probe entry. A pair is only used if the probe shows no new entry after both frames; otherwise the
 * pair is retaken.
 */
async function quietFrameCount(canvas: Locator): Promise<Fresh> {
  for (let attempt = 1; attempt <= 5; attempt++) {
    const before = await played();
    const last = before[before.length - 1];
    if (last) {
      await page.waitForFunction((t) => performance.now() - t >= 1600, last.at, { polling: 50 });
    }
    const first = await canvas.screenshot();
    const second = await canvas.screenshot();
    if ((await played()).length !== before.length) continue; // a celebration started: retake
    expect(pngSize(first), "canvas size is stable across the control frames").toEqual(
      pngSize(second),
    );
    return newEffectPixels(second, first);
  }
  throw new Error("no quiet window for the negative control in 5 attempts");
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

  // The demo runs for ~30 s of real time; do not wait for it, watch the probe while it runs.
  const demo = runDemo(7);

  // Catch the moment a confetti pop or a high-five plays and capture the canvas right then.
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
  // Three frames back to back: one late screenshot must not decide the test (a high-five lives
  // 700 ms). The best frame is the one compared and saved.
  const frames: Buffer[] = [];
  for (let i = 0; i < 3; i++) frames.push(await canvas.screenshot());

  // The same scene once the effect is over (confetti lives 1.2 s; the next burst is >= 2 s away).
  await page.waitForFunction((t) => performance.now() - t >= 1600, at, { polling: 50 });
  const settled = await canvas.screenshot();

  // The canvas must not have resized between the frames, or the comparison means nothing.
  for (const f of frames)
    expect(pngSize(f), "canvas size is stable across frames").toEqual(pngSize(settled));

  // Only particle-coloured pixels that the settled frame lacks: agents, buildings and their
  // movement are in both frames, so a pass means the effect itself drew.
  const counts: number[] = [];
  for (const f of frames) counts.push((await newEffectPixels(f, settled)).count);
  const fresh = Math.max(...counts);

  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${kind}.png`, frames[counts.indexOf(fresh)] ?? (frames[0] as Buffer));
  }

  // Negative control, still while the demo runs: with no celebration drawn, the same measure
  // (same matcher) must stay under the threshold, or moving agents are being counted as particles.
  const control = await quietFrameCount(canvas);
  const summary = `during per frame ${counts.join(", ")} (best ${fresh}), control ${control.count}, threshold ${MIN_NEW_PIXELS}, margin x${CONTROL_MARGIN}`;
  console.log(`celebrations e2e: ${kind} ${summary}`);
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
