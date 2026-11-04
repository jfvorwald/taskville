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
    // Freezes unrelated animation (and the highlight's bounce) so pixel comparisons are stable.
    reducedMotion: "reduce",
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

/**
 * Share of pixels that differ between two PNG shots (any channel by more than 8 of 255), decoded in
 * the page so the test needs no image library.
 */
async function diffShare(a: Buffer, b: Buffer): Promise<number> {
  return page.evaluate(
    async ([x, y]) => {
      const load = async (b64: string) => {
        const img = new Image();
        img.src = `data:image/png;base64,${b64}`;
        await img.decode();
        const c = document.createElement("canvas");
        c.width = img.width;
        c.height = img.height;
        const g = c.getContext("2d") as CanvasRenderingContext2D;
        g.drawImage(img, 0, 0);
        return g.getImageData(0, 0, c.width, c.height).data;
      };
      const [da, db] = [await load(x as string), await load(y as string)];
      let changed = 0;
      for (let i = 0; i < da.length; i += 4) {
        const d = Math.max(
          Math.abs((da[i] ?? 0) - (db[i] ?? 0)),
          Math.abs((da[i + 1] ?? 0) - (db[i + 1] ?? 0)),
          Math.abs((da[i + 2] ?? 0) - (db[i + 2] ?? 0)),
        );
        if (d > 8) changed += 1;
      }
      return changed / (da.length / 4);
    },
    [a.toString("base64"), b.toString("base64")],
  );
}

test("the Crew tab lists the family and highlights it in the city", async () => {
  await row(SESSION).click();
  await expect(panel()).toHaveAttribute("data-agent-id", SESSION);
  await panel().getByRole("tab", { name: "Crew" }).click();
  await expect(panel().getByTestId("agent-panel-tab-slot")).toHaveAttribute("data-tab", "crew");
  const rows = panel().getByTestId("crew-row");
  await expect(rows).toHaveCount(2);
  await expect(rows.and(page.locator(`[data-agent-id="${SUB_A}"]`))).toBeVisible();
  await expect(rows.and(page.locator(`[data-agent-id="${SUB_B}"]`))).toBeVisible();
  // The team lead and teammates are a different family and are not in this crew.
  await expect(panel().locator(`[data-agent-id="${PIP}"]`)).toHaveCount(0);

  // The highlight (dim outside the family, ground ring, tethers) is drawn in WebGL and has no DOM
  // marker, so it is checked in pixels. The context asks
  // for reduced motion (no bounce, no unrelated animation), and the shots clip to a city region
  // that the panel, the agent list and the camera controls do not cover (1000x640 viewport: the
  // list is left of x 312, the panel right of x 640, the controls above y 53).
  const region = { x: 330, y: 70, width: 300, height: 280 };
  for (const id of ["agent-panel", "agent-list", "camera-controls"]) {
    const b = await page.getByTestId(id).boundingBox();
    if (b === null) throw new Error(`${id} not visible`);
    const apart =
      b.x >= region.x + region.width ||
      b.x + b.width <= region.x ||
      b.y >= region.y + region.height ||
      b.y + b.height <= region.y;
    expect(apart, `${id} overlaps the clip region`).toBe(true);
  }
  const shot = async () => {
    await page.waitForTimeout(1200);
    return page.screenshot({ clip: region, animations: "allow" });
  };
  // The highlight is on while the Crew tab is open (dim outside the family, ring, tethers) and a
  // hover only adds a bounce, which reduced motion removes. So the on/off pair is the Crew tab
  // open versus the Live tab, and the panel is outside the clip. The pointer rests on the panel's
  // title in every shot, never on a crew row or the city.
  const title = panel().getByTestId("agent-panel-name");
  const openCrew = async () => {
    await panel().getByRole("tab", { name: "Crew" }).click();
    await expect(panel().getByTestId("agent-panel-tab-slot")).toHaveAttribute("data-tab", "crew");
    await title.hover();
  };
  const openLive = async () => {
    await panel().getByRole("tab", { name: "Live" }).click();
    await expect(panel().getByTestId("agent-panel-tab-slot")).toHaveAttribute("data-tab", "live");
    await title.hover();
  };
  await openLive();
  const control1 = await shot();
  const control2 = await shot();
  const quiet = await diffShare(control1, control2);

  await openCrew();
  const highlighted = await shot();
  const appeared = await diffShare(control2, highlighted);

  // Informational: hover on a crew row (a bounce, frozen by reduced motion).
  await rows.first().getByRole("button").hover();
  const hovered = await shot();
  const hoverExtra = await diffShare(highlighted, hovered);

  await openLive();
  const cleared = await shot();
  const returned = await diffShare(control2, cleared);

  console.log(
    `M5.11 HIGHLIGHT changed-pixel share: control vs control ${(quiet * 100).toFixed(3)} %, Crew tab open vs Live ${(appeared * 100).toFixed(3)} %, back to Live vs control ${(returned * 100).toFixed(3)} %, row hover vs open ${(hoverExtra * 100).toFixed(3)} % (not asserted)`,
  );
  const TOLERANCE = 0.001;
  // Measured: noise floor 0.000 % (control pair), highlight about 0.14 %; the bots here are small.
  const APPEARS = 0.0005;
  // The control: two shots in the same unhovered state match.
  expect(quiet).toBeLessThan(TOLERANCE);
  // Opening the Crew tab draws the highlight in that region, and leaving it clears it.
  expect(appeared).toBeGreaterThan(APPEARS);
  expect(returned).toBeLessThan(TOLERANCE);
});
