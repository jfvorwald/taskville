import { mkdirSync } from "node:fs";
import { join } from "node:path";
import {
  type Engine,
  hookName,
  PROJECT_ID,
  postHook,
  readRecording,
  SUBAGENT_FIXTURE,
  snapshotOf,
  startEngine,
  TEAM_FIXTURE,
} from "./harness.ts";
import { type BrowserContext, expect, type Page, test } from "./playwright.ts";

// M5.11 (#72): real crews and the live feed, through the real engine and the real built web app.
// Recorded real Claude Code hook payloads (fixtures/claude-code/subagent/parallel.jsonl and
// team/in-process.jsonl) are replayed untouched through the telemetry route; no model and no live
// `claude` (decision #289 default). ARCHITECTURE.md 14, M5 done when.
//
// The subagent recording is replayed up to seq 19. Seq 20 (subagent afdf's Bash tool call) is held
// back and posted while that subagent's feed is open, to measure ingest-to-panel lag.

const OUT = process.env.CREWS_OUT ?? join(import.meta.dirname, "test-results", "clip");
const SESSION = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const SUB_A = `${SESSION}:afdf84bea07a9064c`;
const SUB_B = `${SESSION}:a0b4668e13e056653`;
const LEAD = "claude-code:cf46f41b-8048-4a06-b955-b342dd0c7f31";
const PIP = `${LEAD}:apip-5cb5e9bb3f2f1097`;
const BO = `${LEAD}:abo-4381c522227780d5`;
const HELD_SEQ = 20;
const LAG_BUDGET_MS = 1000;

test.describe.configure({ mode: "serial" });

let engine: Engine;
let context: BrowserContext;
let page: Page;

const row = (id: string) => page.getByTestId("agent-list").locator(`[data-agent-id="${id}"]`);
const panel = () => page.getByTestId("agent-panel");
const feed = () => page.getByRole("feed", { name: "Tool calls" });

test.beforeAll(async ({ browser }) => {
  mkdirSync(OUT, { recursive: true });
  engine = await startEngine();
  context = await browser.newContext({
    baseURL: engine.url,
    viewport: { width: 1000, height: 640 },
    recordVideo: { dir: OUT, size: { width: 800, height: 512 } },
  });
  page = await context.newPage();
  await page.goto(`/#pair=${engine.pairingCode}`);
  await expect(page.getByTestId("scene-root")).toBeVisible({ timeout: 20_000 });
  for (const h of readRecording(SUBAGENT_FIXTURE).filter((r) => r.seq < HELD_SEQ)) {
    await postHook(engine, h);
  }
  for (const h of readRecording(TEAM_FIXTURE)) await postHook(engine, h);
});

test.afterAll(async () => {
  test.setTimeout(30_000);
  await context?.close();
  await engine?.stop();
});

test("crew visuals: subagents and a team appear as crews of their leads", async () => {
  const state = await snapshotOf(engine, PROJECT_ID);
  for (const id of [SUB_A, SUB_B]) {
    expect(state.agents[id]?.kind).toBe("subagent");
    expect(state.agents[id]?.parentAgentId).toBe(SESSION);
  }
  expect(state.agents[LEAD]?.kind).toBe("lead");
  for (const id of [PIP, BO]) {
    expect(state.agents[id]?.kind).toBe("teammate");
    expect(state.agents[id]?.teamId).toBe(state.agents[LEAD]?.teamId);
  }
  expect(state.teams[state.agents[LEAD]?.teamId ?? ""]?.memberAgentIds).toEqual(
    expect.arrayContaining([LEAD, PIP, BO]),
  );

  // The same crews in the browser: one list row per agent, subagents labelled as such.
  for (const id of [SESSION, SUB_A, SUB_B, LEAD, PIP, BO]) {
    await expect(row(id)).toBeVisible({ timeout: 15_000 });
  }
  await expect(row(SUB_A)).toHaveAttribute("aria-label", /subagent/);
  await expect(row(SUB_B)).toHaveAttribute("aria-label", /subagent, Completed/);
  await expect(row(PIP)).toHaveAttribute("aria-label", /^pip,/);

  // Selecting the parent opens its panel with the Crew tab (a parent has one, a leaf does not).
  await row(SESSION).click();
  await expect(panel()).toHaveAttribute("data-agent-id", SESSION);
  await expect(panel().getByRole("tab", { name: "Crew" })).toBeVisible();
  await row(SUB_A).click();
  await expect(panel()).toHaveAttribute("data-kind", "subagent");
  await expect(panel().getByRole("tab", { name: "Crew" })).toHaveCount(0);
});

test("selecting a subagent shows its feed, and a new event lands in under one second", async () => {
  await row(SUB_A).click();
  await expect(panel()).toHaveAttribute("data-agent-id", SUB_A);
  await expect(
    feed()
      .getByRole("article")
      .filter({ hasText: /^Read:/ }),
  ).toBeVisible();
  await expect(
    feed()
      .getByRole("article")
      .filter({ hasText: /^Edit:/ }),
  ).toBeVisible();
  // The other subagent's call is not in this feed.
  await expect(
    feed()
      .getByRole("article")
      .filter({ hasText: /^Write:/ }),
  ).toHaveCount(0);

  // Watch the feed in the page and stamp the wall-clock time the new card first appears.
  await page.evaluate(() => {
    const w = window as unknown as { __cardAt?: number };
    const look = () => {
      const hit = [...document.querySelectorAll('[role="feed"] article')].some((a) =>
        /wc -l .*notes\.txt/.test(a.textContent ?? ""),
      );
      if (hit && w.__cardAt === undefined) w.__cardAt = Date.now();
    };
    new MutationObserver(look).observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
    });
  });

  const held = readRecording(SUBAGENT_FIXTURE).find((r) => r.seq === HELD_SEQ);
  expect(held && hookName(held)).toBe("PreToolUse");
  expect(held?.input.tool_name).toBe("Bash");
  const sentAt = Date.now();
  await postHook(engine, held as NonNullable<typeof held>);
  const ingestedAt = Date.now();
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { __cardAt?: number }).__cardAt), {
      timeout: 10_000,
    })
    .toBeDefined();
  const cardAt = await page.evaluate(() => (window as unknown as { __cardAt: number }).__cardAt);
  const fromIngest = Math.max(0, cardAt - ingestedAt);
  const fromSend = cardAt - sentAt;
  console.log(
    `M5.11 LAG ingest-to-panel ${fromIngest} ms (POST response to card); send-to-panel ${fromSend} ms; budget ${LAG_BUDGET_MS} ms`,
  );
  expect(fromIngest).toBeLessThan(LAG_BUDGET_MS);
  await expect(
    feed()
      .getByRole("article")
      .filter({ hasText: /wc -l .*notes\.txt/ }),
  ).toBeVisible();
});

test("the Crew tab lists the family and highlights it in the city", async () => {
  await row(SESSION).click();
  await expect(panel()).toHaveAttribute("data-agent-id", SESSION);
  // A live WebGL canvas is never "stable" for Playwright, so shoot its box from the page.
  const canvas = page.getByTestId("scene-root").locator("canvas").first();
  const box = await canvas.boundingBox();
  if (box === null) throw new Error("no city canvas");
  const shot = () => page.screenshot({ clip: box, animations: "allow" });
  const before = await shot();

  await panel().getByRole("tab", { name: "Crew" }).click();
  await expect(panel().getByTestId("agent-panel-tab-slot")).toHaveAttribute("data-tab", "crew");
  const rows = panel().getByTestId("crew-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.and(page.locator(`[data-agent-id="${SUB_A}"]`))).toBeVisible();
  await expect(rows.and(page.locator(`[data-agent-id="${SUB_B}"]`))).toBeVisible();
  // The team lead and teammates are a different family and are not in this crew.
  await expect(panel().locator(`[data-agent-id="${PIP}"]`)).toHaveCount(0);

  // The highlight (dim outside the family, ground ring, tethers) is drawn in WebGL and has no DOM
  // marker, so it is checked as a pixel change in the city canvas while the tab is open and
  // hovered, and its reversal when the tab closes. See the M5.11 report.
  await rows.first().getByRole("button").hover();
  await page.waitForTimeout(1200);
  const during = await shot();
  expect(Buffer.compare(before, during)).not.toBe(0);

  await panel().getByRole("tab", { name: "Live" }).click();
  await page.waitForTimeout(1200);
  const after = await shot();
  expect(Buffer.compare(during, after)).not.toBe(0);
});
