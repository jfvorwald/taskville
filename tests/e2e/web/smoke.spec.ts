import { type BrowserContext, expect, type Locator, type Page, test } from "./playwright.ts";
import { CORE, PORT, runDemo, webCodes } from "./support.ts";

// M3.16 smoke: the demo city renders, selection works, and a theme switch keeps the city's state.
// It is mostly a regression suite over the integrated M3 work. One paired page is shared (the
// pairing code is single use), after the seeded demo has put its six agents in the engine.
//
// Needs the test-hook build only for the engine's code list; it uses no URL hooks. Run it with
// the commands in README.md.

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let controls: Locator;
let list: Locator;
let items: Locator;
const pageErrors: string[] = [];

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const { web, home } = webCodes();
  context = await browser.newContext({ baseURL: `http://127.0.0.1:${PORT}` });
  page = await context.newPage();
  page.on("pageerror", (error) => pageErrors.push(error.message));
  await page.goto(`/#pair=${web}`);
  await expect(page.getByTestId("scene-root")).toBeVisible({ timeout: 20_000 });

  // Thirty simulated minutes at 120x (about 15 s): six demo agents exist in the engine.
  const demo = await runDemo(home);
  expect(demo.code, demo.output).toBe(0);

  controls = page.getByTestId("camera-controls");
  list = page
    .getByRole("grid", { name: "Agents" })
    .or(page.getByRole("listbox", { name: "Agents" }));
  items = list.getByRole("row").or(list.getByRole("option"));
});

test.afterAll(async () => {
  await context?.close();
});

/** The ids, in the scene's own label order, of the agents the city shows. */
const sceneAgentIds = () =>
  page
    .getByTestId("agent-label")
    .evaluateAll((els) => els.map((el) => (el as HTMLElement).dataset.agentId ?? "").sort());

test("the demo city renders with its six agents", async () => {
  const canvas = page.locator("canvas");
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  expect(box?.width ?? 0).toBeGreaterThan(200);
  expect(box?.height ?? 0).toBeGreaterThan(200);
  await expect(page.getByTestId("overlay-root")).toContainText("paired");

  // Each demo agent has exactly one world label and one row in the agent list.
  const labels = page.getByTestId("agent-label");
  for (const name of CORE) {
    await expect(labels.filter({ hasText: name })).toHaveCount(1, { timeout: 30_000 });
    await expect(items.filter({ hasText: name })).toHaveCount(1);
  }
  expect((await sceneAgentIds()).length).toBeGreaterThanOrEqual(CORE.length);
  expect(pageErrors).toEqual([]);
});

test("selecting an agent in the list selects it in the city", async () => {
  await expect(controls).toHaveAttribute("data-selected-id", "");
  for (const name of ["Cyd", "Fay"]) {
    const row = items.filter({ hasText: name });
    const id = await row.getAttribute("data-agent-id");
    expect(id, `an id on the ${name} row`).toBeTruthy();
    await row.click();
    await expect(controls).toHaveAttribute("data-selected-id", id ?? "");
    // It is the same agent the scene labels.
    await expect(page.locator(`[data-testid=agent-label][data-agent-id="${id}"]`)).toContainText(
      name,
    );
  }
});

test("a theme switch changes the theme and keeps agents, selection and camera", async () => {
  // A known state to preserve: Cyd selected, the camera turned and zoomed.
  const cyd = items.filter({ hasText: "Cyd" });
  const cydId = (await cyd.getAttribute("data-agent-id")) ?? "";
  await cyd.click();
  await expect(controls).toHaveAttribute("data-selected-id", cydId);
  await page.getByRole("button", { name: "Turn right" }).click();
  await page.getByRole("button", { name: "Turn right" }).click();
  await page.getByRole("button", { name: "Zoom in" }).click();
  await expect(controls).toHaveAttribute("data-azimuth-offset", "30");
  const zoom = await controls.getAttribute("data-zoom");
  expect(Number(zoom)).toBeGreaterThan(1);

  const html = page.locator("html");
  const before = {
    theme: await html.getAttribute("data-theme"),
    background: await html.evaluate((el) => el.style.getPropertyValue("--tv-scene-bg")),
    agents: await sceneAgentIds(),
  };
  expect(before.theme).toBe("cyberpunk");
  expect(before.agents.length).toBeGreaterThanOrEqual(CORE.length);

  // Settings panel: open it and pick another theme.
  const toggle = page.getByRole("button", { name: "Settings" });
  if ((await toggle.getAttribute("aria-expanded")) !== "true") await toggle.click();
  await page.getByText("Steampunk", { exact: true }).click();

  await expect(html).toHaveAttribute("data-theme", "steampunk");
  const background = await html.evaluate((el) => el.style.getPropertyValue("--tv-scene-bg"));
  expect(background).not.toBe("");
  expect(background).not.toBe(before.background);
  await expect(page.locator("canvas")).toBeVisible();

  // Nothing but the look changed.
  expect(await sceneAgentIds()).toEqual(before.agents);
  await expect(controls).toHaveAttribute("data-selected-id", cydId);
  await expect(controls).toHaveAttribute("data-azimuth-offset", "30");
  await expect(controls).toHaveAttribute("data-zoom", zoom ?? "");
  expect(pageErrors).toEqual([]);
});
