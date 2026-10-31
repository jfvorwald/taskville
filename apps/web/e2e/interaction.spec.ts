import { readFileSync } from "node:fs";
import { expect, type Locator, type Page, test } from "@playwright/test";
import { CODES_FILE } from "./codes.ts";

// M3.11: picking, selection, camera reset, occlusion fade. The page mounts two fixed agents when
// the URL has ?tv-fixture=agents (src/city/interaction/fixture.ts), because the real agents are
// mounted by other tickets. The fixture also publishes `window.__tvProbe`, which reports where
// the live camera puts a fixture point, so clicks land where things really are. Both tests share
// one paired page (the pairing code is single use).

const code = (): string => JSON.parse(readFileSync(CODES_FILE, "utf8")).interaction;

const FRONT = "fixture-front";
const HIDDEN = "fixture-hidden";

test.describe.configure({ mode: "serial" });

let page: Page;
let canvas: Locator;
let controls: Locator;
let box: { x: number; y: number; width: number; height: number };

test.beforeAll(async ({ browser }) => {
  page = await browser.newPage({ baseURL: `http://127.0.0.1:${process.env.E2E_PORT ?? 4817}` });
  await page.goto(`/?tv-fixture=agents#pair=${code()}`);
  canvas = page.locator("canvas");
  await expect(canvas).toBeVisible({ timeout: 20_000 });
  controls = page.getByTestId("camera-controls");
  await expect(controls).toBeVisible();
  const b = await canvas.boundingBox();
  if (!b) throw new Error("no canvas box");
  box = b;
  await page.waitForTimeout(1000); // first frames, agents mounted, anchors projected
});

test.afterAll(async () => {
  await page.close();
});

/** Page coordinates of a fixture anchor under the camera as it is now. */
async function where(id: string): Promise<{ x: number; y: number }> {
  let p: { x: number; y: number } | null | undefined = null;
  await expect
    .poll(async () => {
      p = await page.evaluate((anchor) => window.__tvProbe?.(anchor) ?? null, id);
      return p !== null;
    })
    .toBe(true);
  if (!p) throw new Error(`no projection for ${id}`);
  const { x, y } = p as { x: number; y: number };
  return { x: box.x + x, y: box.y + y };
}

const selected = (id: string) => expect(controls).toHaveAttribute("data-selected-id", id);

test("clicking an agent selects it, and Reset view restores the camera", async () => {
  const agent = await where(`fixture:${FRONT}`);
  const empty = await where("fixture:empty");

  // Hovering the agent glows (the cursor becomes a pointer) and a click selects it.
  await page.mouse.move(agent.x, agent.y);
  await expect.poll(() => canvas.evaluate((c) => (c as HTMLElement).style.cursor)).toBe("pointer");
  if (process.env.E2E_SCREENSHOT_DIR) {
    await page.waitForTimeout(100);
    await page.screenshot({
      path: `${process.env.E2E_SCREENSHOT_DIR}/hover-glow.png`,
      clip: { x: agent.x - 60, y: agent.y - 50, width: 120, height: 100 },
    });
  }
  await page.mouse.click(agent.x, agent.y);
  await selected(FRONT);
  if (process.env.E2E_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/selected.png` });
  }

  // Clicking empty ground clears it.
  await page.mouse.click(empty.x, empty.y);
  await selected("");

  // Dragging turns the camera and is not a click.
  const y = box.y + box.height - 40;
  await page.mouse.move(box.x + box.width / 2, y);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width / 2 + 160, y, { steps: 8 });
  await page.mouse.up();
  await expect(controls).not.toHaveAttribute("data-azimuth-offset", "0");
  await selected("");
  // The wheel zooms.
  await page.mouse.move(box.x + box.width / 2, box.y + 60);
  await page.mouse.wheel(0, -300);
  await expect(controls).not.toHaveAttribute("data-zoom", "1");

  // The camera really moved: the agent is no longer under its default screen position.
  await page.waitForTimeout(300);
  const moved = await where(`fixture:${FRONT}`);
  expect(Math.hypot(moved.x - agent.x, moved.y - agent.y)).toBeGreaterThan(30);

  // Reset restores the default view: the agent is back under its default screen position.
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(controls).toHaveAttribute("data-azimuth-offset", "0");
  await expect(controls).toHaveAttribute("data-zoom", "1");
  await page.waitForTimeout(300);
  const back = await where(`fixture:${FRONT}`);
  expect(back.x).toBeCloseTo(agent.x, 1);
  expect(back.y).toBeCloseTo(agent.y, 1);
  await page.mouse.click(back.x, back.y);
  await selected(FRONT);
  await page.mouse.click(empty.x, empty.y);
  await selected("");
});

test("selecting an agent behind a building fades that building, and Escape brings it back", async () => {
  // Under the default camera Review stands between the camera and the hidden agent. Turn the
  // camera half way round (12 steps of 15 degrees), where the agent is in plain view, select it.
  for (let i = 0; i < 12; i++) await page.getByRole("button", { name: "Turn right" }).click();
  await expect(controls).toHaveAttribute("data-azimuth-offset", "180");
  await page.waitForTimeout(300);
  const seen = await where(`fixture:${HIDDEN}`);
  await page.mouse.click(seen.x, seen.y);
  await selected(HIDDEN);
  await expect(canvas).not.toHaveAttribute("data-faded-areas", /review/);

  // Back to the default view: Review is in the way, and fades.
  await page.getByRole("button", { name: "Reset view" }).click();
  await expect(canvas).toHaveAttribute("data-faded-areas", /review/);
  await page.waitForTimeout(400);
  if (process.env.E2E_SCREENSHOT_DIR) {
    await page.screenshot({ path: `${process.env.E2E_SCREENSHOT_DIR}/occlusion-fade.png` });
  }

  // Faded buildings are looked through: a click where Review stands does not select it.
  const review = await where("fixture:review");
  await page.mouse.click(review.x, review.y);
  await expect(controls).not.toHaveAttribute("data-selected-id", "area:review");

  // Escape clears the selection and the building returns.
  await page.keyboard.press("Escape");
  await selected("");
  await expect(canvas).toHaveAttribute("data-faded-areas", "");
});
