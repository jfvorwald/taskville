import { readFileSync } from "node:fs";
import AxeBuilder from "@axe-core/playwright";
import { type BrowserContext, expect, type Locator, type Page, test } from "@playwright/test";
import { run } from "../../cli/src/main.ts";
import { CODES_FILE } from "./codes.ts";

// M3.14: the accessible agent list mirrors the scene. It is found by role (a React Aria GridList
// or ListBox named "Agents"), reachable and operable by keyboard, honors reduced motion, and has
// no serious or critical axe violations. The list element carries data-testid="agent-list" and
// each item carries data-agent-id (the same id the world label and camera-controls use).
//
// The engine issues the pairing code named `accessibility` (e2e/engine.ts). Each code is single
// use, so both tests share one paired page.

const CORE = ["Ada", "Brook", "Cyd", "Dee", "Eli", "Fay"];
const port = Number(process.env.E2E_PORT ?? 4817);

interface Codes {
  accessibility?: string;
  home: string;
}
const codes = (): Codes => JSON.parse(readFileSync(CODES_FILE, "utf8"));

test.describe.configure({ mode: "serial" });

let context: BrowserContext;
let page: Page;
let list: Locator;
let items: Locator;

test.beforeAll(async ({ browser }) => {
  test.setTimeout(120_000);
  const { accessibility, home } = codes();
  if (!accessibility) {
    throw new Error("e2e/engine.ts must issue a pairing code named `accessibility`");
  }
  // AxeBuilder requires a page from browser.newContext(), not browser.newPage().
  context = await browser.newContext({ baseURL: `http://127.0.0.1:${port}` });
  page = await context.newPage();
  await page.goto(`/#pair=${accessibility}`);
  await expect(page.getByTestId("scene-root")).toBeVisible({ timeout: 20_000 });

  // Thirty simulated minutes at 120x: six demo agents exist in the engine and in the city.
  const out: string[] = [];
  const io = {
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => out.push(t),
    env: {},
    cwd: home,
  };
  const code = await run(
    [
      "demo",
      "start",
      "--project",
      "unsorted",
      "--seed",
      "7",
      "--speed",
      "120",
      "--duration",
      "30m",
      "--home",
      home,
      "--url",
      `http://127.0.0.1:${port}`,
    ],
    io,
  );
  expect(code, out.join("")).toBe(0);

  // Either React Aria collection renders it: GridList is role=grid with rows, ListBox is
  // role=listbox with options.
  list = page
    .getByRole("grid", { name: "Agents" })
    .or(page.getByRole("listbox", { name: "Agents" }));
  items = list.getByRole("row").or(list.getByRole("option"));
});

test.afterAll(async () => {
  await context?.close();
});

test("the agent list mirrors the scene, works by keyboard, and has no serious axe violations", async () => {
  await expect(list).toBeVisible({ timeout: 20_000 });
  await expect(list).toHaveAttribute("data-testid", "agent-list");
  for (const name of CORE) {
    await expect(items.filter({ hasText: name }).first()).toBeVisible({ timeout: 30_000 });
  }

  // Every row speaks the scene's label: the name and the recorded status, in one accessible name.
  const labels = await page.getByTestId("agent-label").evaluateAll((els) =>
    els.map((el) => ({
      id: (el as HTMLElement).dataset.agentId ?? "",
      name: el.querySelector("span")?.textContent ?? "",
    })),
  );
  expect(labels.length).toBeGreaterThanOrEqual(CORE.length);
  for (const { id, name } of labels) {
    const row = list.locator(`[data-agent-id="${id}"]`);
    await expect(row, `a list row for ${name}`).toHaveCount(1);
    await expect(row).toContainText(name);
  }

  // Keyboard: the list is one tab stop, arrows move between rows, Enter selects the agent in
  // the scene (the camera controls report the selection), Tab leaves the list.
  const controls = page.getByTestId("camera-controls");
  const selectedBefore = await controls.getAttribute("data-selected-id");
  const first = items.first();
  await first.focus();
  await expect(first).toBeFocused();
  await page.keyboard.press("ArrowDown");
  const second = items.nth(1);
  await expect(second).toBeFocused();
  // Browsing is not selecting: arrows move focus only (React Aria's selectionBehavior "replace"
  // would select every row focus passes).
  await expect(controls).toHaveAttribute("data-selected-id", selectedBefore ?? "");
  await page.keyboard.press("ArrowUp");
  await expect(first).toBeFocused();
  await expect(controls).toHaveAttribute("data-selected-id", selectedBefore ?? "");
  await page.keyboard.press("ArrowDown");
  await expect(second).toBeFocused();
  await expect(controls).toHaveAttribute("data-selected-id", selectedBefore ?? "");
  const pickedId = await second.getAttribute("data-agent-id");
  expect(pickedId).toBeTruthy();
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("camera-controls")).toHaveAttribute(
    "data-selected-id",
    pickedId ?? "",
  );
  await page.keyboard.press("Tab");
  const stillInList = await list.evaluate((el) => el.contains(document.activeElement));
  expect(stillInList, "Tab should leave the list").toBe(false);

  // Axe, scoped to the list: nothing serious or critical.
  const results = await new AxeBuilder({ page }).include('[data-testid="agent-list"]').analyze();
  const blocking = results.violations.filter(
    (v) => v.impact === "serious" || v.impact === "critical",
  );
  expect(
    blocking.map((v) => `${v.id} (${v.impact}): ${v.help} [${v.nodes.length} nodes]`),
    "serious or critical axe violations in the agent list",
  ).toEqual([]);
});

test("with reduced motion the list has no animation or transition", async () => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await expect(list).toBeVisible();
  const motion = await list.evaluate((el) => {
    const nodes = [el, ...el.querySelectorAll("*")] as HTMLElement[];
    return nodes
      .map((n) => getComputedStyle(n))
      .filter(
        (s) =>
          s.animationName !== "none" ||
          s.transitionDuration.split(",").some((d) => Number.parseFloat(d) > 0),
      )
      .map((s) => `${s.animationName} / ${s.transitionDuration}`);
  });
  expect(motion).toEqual([]);
});

test("a tab hidden for over two seconds comes back with its walkers rebuilt at their destinations", async () => {
  test.setTimeout(120_000);
  // Reduced motion snaps walkers on its own, which would hide a missing rebuild.
  await page.emulateMedia({ reducedMotion: "no-preference" });
  await page.goto("/?debug=movement");
  await expect(page.getByTestId("scene-root")).toBeVisible({ timeout: 20_000 });
  await page.waitForFunction(
    () =>
      typeof (window as unknown as { __taskvilleMovement?: unknown }).__taskvilleMovement ===
      "function",
    undefined,
    { timeout: 20_000 },
  );

  // A fresh demo run keeps new agents walking to their areas.
  const { home } = codes();
  const out: string[] = [];
  // Aborting ends the producer, so no new walk can start after the hide.
  const stopDemo = new AbortController();
  const io = {
    stdout: (t: string) => out.push(t),
    stderr: (t: string) => out.push(t),
    env: {},
    cwd: home,
    signal: stopDemo.signal,
  };
  // `demo start` runs until the simulated duration has played out, so it is not awaited yet.
  const demo = run(
    [
      "demo",
      "start",
      "--project",
      "unsorted",
      "--seed",
      "11",
      "--speed",
      "120",
      "--duration",
      "60m",
      "--home",
      home,
      "--url",
      `http://127.0.0.1:${port}`,
    ],
    io,
  );

  // Hide the tab the moment someone is mid-walk.
  await page.waitForFunction(
    () => {
      const w = window as unknown as {
        __taskvilleMovement: () => { onTheWay: boolean; gone: boolean }[];
      };
      return w.__taskvilleMovement().some((a) => !a.gone && a.onTheWay);
    },
    undefined,
    { timeout: 60_000, polling: 50 },
  );
  // The producer keeps emitting events every 42 to 125 ms, so a new walk could start between the
  // resume rebuild and the assertion. Stop it, wait for the call to finish, then wait until the
  // browser has applied the last event: the agents' states stop changing for 300 ms.
  stopDemo.abort();
  expect(await demo, out.join("")).toBe(0);
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const snapshot = () =>
          JSON.stringify(
            (
              window as unknown as {
                __taskvilleMovement: () => {
                  id: string;
                  state: string;
                  onTheWay: boolean;
                  gone: boolean;
                }[];
              }
            )
              .__taskvilleMovement()
              .map((a) => [a.id, a.state, a.onTheWay, a.gone]),
          );
        let last = snapshot();
        let since = performance.now();
        const timer = setInterval(() => {
          const now = snapshot();
          if (now !== last) {
            last = now;
            since = performance.now();
          } else if (performance.now() - since >= 300) {
            clearInterval(timer);
            resolve();
          }
        }, 50);
      }),
  );
  await page.evaluate(() => {
    Object.defineProperty(document, "visibilityState", {
      configurable: true,
      get: () => "hidden",
    });
    document.dispatchEvent(new Event("visibilitychange"));
  });
  await page.waitForTimeout(2_600);

  // Return, then look at the walkers after two frames.
  const walkingAfterReturn = await page.evaluate(async () => {
    Reflect.deleteProperty(document, "visibilityState");
    document.dispatchEvent(new Event("visibilitychange"));
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
    return (
      window as unknown as { __taskvilleMovement: () => { onTheWay: boolean; gone: boolean }[] }
    )
      .__taskvilleMovement()
      .filter((w) => !w.gone && w.onTheWay).length;
  });
  expect(walkingAfterReturn, "agents still walking right after the tab returned").toBe(0);
});
