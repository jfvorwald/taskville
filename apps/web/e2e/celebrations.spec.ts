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
const codes = (): { celebrations?: string; paired: string; home: string } =>
  JSON.parse(readFileSync(CODES_FILE, "utf8"));
// engine.ts should issue a dedicated `celebrations` code; until it does, fall back to `paired` so a
// single-spec run still reaches the probe (in a full run `paired` is shared with other specs).
const pairingCode = (): string => codes().celebrations ?? codes().paired;

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

/** Pixels that differ noticeably between two PNGs of the same size, counted in the browser. */
async function changedPixels(a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([x, y]) => {
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
      if (p.width !== q.width || p.height !== q.height) return Number.POSITIVE_INFINITY;
      let n = 0;
      for (let i = 0; i < p.data.length; i += 4) {
        const d =
          Math.abs((p.data[i] ?? 0) - (q.data[i] ?? 0)) +
          Math.abs((p.data[i + 1] ?? 0) - (q.data[i + 1] ?? 0)) +
          Math.abs((p.data[i + 2] ?? 0) - (q.data[i + 2] ?? 0));
        if (d > 60) n += 1;
      }
      return n;
    },
    [a.toString("base64"), b.toString("base64")],
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
  await expect.poll(() => played(), { timeout: 15_000 }).toEqual([]);
  await page.waitForTimeout(1500); // let the first WebGL frames draw
  const before = await canvas.screenshot();

  // The demo runs for ~30 s of real time; do not wait for it, watch the probe while it runs.
  const demo = runDemo(7);

  // Catch the moment a confetti pop or a high-five plays and capture the canvas right then.
  const seen = await page.waitForFunction(
    () => {
      const probe = (window as unknown as { __taskvilleCelebrations?: () => Played[] })
        .__taskvilleCelebrations;
      const hit = probe?.().find((p) => p.kind === "confetti" || p.kind === "high-five");
      return hit ? hit.kind : false;
    },
    undefined,
    { polling: 30, timeout: 90_000 },
  );
  const kind = (await seen.jsonValue()) as string;
  const during = await canvas.screenshot();

  const dir = process.env.E2E_SCREENSHOT_DIR;
  if (dir) {
    mkdirSync(dir, { recursive: true });
    writeFileSync(`${dir}/${kind}.png`, during);
  }

  expect(
    await changedPixels(before, during),
    "canvas differs while a celebration plays",
  ).toBeGreaterThan(50);

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
  await expect.poll(() => played(), { timeout: 15_000 }).toEqual([]);

  // A different seed: the first demo's events are already recorded and must not be deduplicated.
  const demo = runDemo(8);
  await expect.poll(async () => (await played()).length, { timeout: 90_000 }).toBeGreaterThan(0);
  await demo;

  const all = await played();
  expect(all.length).toBeGreaterThan(0);
  expect(all.map((p) => p.kind)).toEqual(all.map(() => "sparkle"));
});
