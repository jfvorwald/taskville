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

test("the demo plays confetti or a high-five, spaced at least 2 s apart", async () => {
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

  // The first confetti pop or high-five.
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
  const { kind } = (await seen.jsonValue()) as Played;

  // Best-effort screenshot for the PR. A screenshot takes longer than a high-five lives, so it may
  // show only the scene; nothing asserts on it. That the particles draw in their palette colours is
  // checked deterministically in src/city/effects/burst.browser.test.tsx.
  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) {
    try {
      mkdirSync(dir, { recursive: true });
      writeFileSync(`${dir}/${kind}.png`, await canvas.screenshot());
    } catch (error) {
      console.log(`celebrations e2e: screenshot skipped: ${String(error)}`);
    }
  }

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
