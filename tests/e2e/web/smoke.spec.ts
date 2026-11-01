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

/** Elements of `scope` that show exactly `name` (hasText would also match "Eli" in "Delivering"). */
const named = (scope: Locator, name: string) =>
  scope.filter({ has: page.getByText(name, { exact: true }) });

/** Clears the city selection with Escape. A focused list row would swallow the key, so blur first. */
const clearSelection = async () => {
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
  await page.keyboard.press("Escape");
  await expect(controls).toHaveAttribute("data-selected-id", "");
};

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
    await expect(named(labels, name)).toHaveCount(1, { timeout: 30_000 });
    await expect(named(items, name)).toHaveCount(1);
  }
  expect((await sceneAgentIds()).length).toBeGreaterThanOrEqual(CORE.length);
  expect(pageErrors).toEqual([]);
});

test("the list selection reaches the city controls", async () => {
  // The 3D scene's selection marker (a ring on the ground) has no DOM or attribute outside the
  // test-hook build, and this suite uses no URL hooks, so the observable city side is the camera
  // controls' selection and the label of the same agent.
  await expect(controls).toHaveAttribute("data-selected-id", "");
  for (const name of ["Cyd", "Fay"]) {
    const row = named(items, name);
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

test("clicking an agent in the city selects it, and the list follows", async () => {
  // No URL hooks: an agent stands just below its label (the label is anchored at its head and is
  // pointer-events: none, so the click goes through to the canvas). Wait until it is not travelling (stuck is a standing state).
  await clearSelection();
  const stillStates = /^(working|waiting|idle|stuck)$/;
  // Ada and Brook stand in the open; Dee and Eli sit behind buildings in the default view.
  for (const name of ["Ada", "Brook"]) {
    const label = named(page.getByTestId("agent-label"), name);
    await expect(label).toHaveAttribute("data-state", stillStates, { timeout: 30_000 });
    const id = (await label.getAttribute("data-agent-id")) ?? "";
    expect(id, `an id on the ${name} label`).not.toBe("");

    // Try a few points below the label until one hits the agent; a miss leaves it unselected.
    let hit = false;
    for (const below of [14, 22, 32, 44]) {
      const box = await label.boundingBox();
      if (!box) throw new Error(`no label box for ${name}`);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height + below);
      if ((await controls.getAttribute("data-selected-id")) === id) {
        hit = true;
        break;
      }
    }
    expect(hit, `a click below ${name}'s label selects ${name}`).toBe(true);
    await expect(named(items, name)).toHaveAttribute("aria-selected", "true");
    await clearSelection();
  }
});

test("a theme switch changes the theme and keeps agents, selection and camera", async () => {
  // A known state to preserve: Cyd selected, the camera turned and zoomed.
  const cyd = named(items, "Cyd");
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
