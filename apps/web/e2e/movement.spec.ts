import { readFileSync } from "node:fs";
import { expect, test } from "@playwright/test";
import { run } from "../../cli/src/main.ts";
import { DEFAULT_ACTIVITY_AREAS } from "../src/city/movement/areas.ts";
import { CODES_FILE } from "./codes.ts";

// M3.06: the seeded demo (`taskville demo start`) drives six agents through the engine; the city
// walks each one to a workstation slot in its area, and no two bots end up on top of each other.

interface Walker {
  id: string;
  x: number;
  z: number;
  state: string;
  onTheWay: boolean;
  slotId: string | null;
  queued: boolean;
  gone: boolean;
}

const CORE = ["Ada", "Brook", "Cyd", "Dee", "Eli", "Fay"];

// The label's status text is the recorded activity (the agents' `agentLabel`); the area an agent
// belongs in is what the app's activity-to-area table says for it. Statuses that name no place
// (Idle, Waiting, Handing off, Working, attention states) are not checked.
const STATUS_ACTIVITY = {
  Implementing: "implementing",
  Testing: "testing",
  Reviewing: "reviewing",
  Researching: "researching",
  Documenting: "documenting",
  Dispatching: "dispatching",
} as const;
const port = Number(process.env.E2E_PORT ?? 4817);

test("six demo agents walk to their areas without overlapping", async ({ page }) => {
  test.setTimeout(120_000);
  const { movement, home } = JSON.parse(readFileSync(CODES_FILE, "utf8")) as {
    movement: string;
    home: string;
  };
  // Pair first (the pairing code is single use), then open the debug view in the same session.
  await page.goto(`/#pair=${movement}`);
  await expect(page.getByTestId("scene-root")).toBeVisible();
  await page.goto("/?debug=movement");
  await expect(page.getByTestId("scene-root")).toBeVisible();

  // Thirty simulated minutes at 120x: every core agent has started work it can be placed for.
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

  const labels = page.getByTestId("agent-label");
  for (const name of CORE) await expect(labels.filter({ hasText: name })).toHaveCount(1);

  // Everyone settles: no walker on the way, each core agent standing at a reserved slot.
  const coreIds = await page.evaluate((names) => {
    const els = [...document.querySelectorAll<HTMLElement>("[data-testid=agent-label]")];
    return els
      .filter((el) => names.some((n) => el.textContent?.startsWith(n)))
      .map((el) => el.dataset.agentId ?? "");
  }, CORE);
  expect(coreIds).toHaveLength(6);

  const snapshot = () =>
    page.evaluate(() =>
      (window as unknown as { __taskvilleMovement: () => Walker[] }).__taskvilleMovement(),
    );
  await expect
    .poll(
      async () => {
        const all = await snapshot();
        const core = all.filter((w) => coreIds.includes(w.id));
        return core.length === 6 && core.every((w) => !w.onTheWay && w.slotId !== null);
      },
      { timeout: 60_000, intervals: [500] },
    )
    .toBe(true);

  const settled = (await snapshot()).filter((w) => !w.gone);
  const core = settled.filter((w) => coreIds.includes(w.id));
  // Distinct slots, and every pair of standing bots at least a body width apart.
  expect(new Set(core.map((w) => w.slotId)).size).toBe(6);
  for (let i = 0; i < settled.length; i++) {
    for (let j = i + 1; j < settled.length; j++) {
      const a = settled[i] as Walker;
      const b = settled[j] as Walker;
      if (a.onTheWay || b.onTheWay) continue;
      expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.id} and ${b.id}`).toBeGreaterThan(0.6);
    }
  }

  // Each core agent stands in the area its current activity maps to (the demo's core agents are
  // main agents, so the activity table alone decides), not just at some slot.
  const misplaced = async () => {
    const { walkers, statuses } = await page.evaluate(() => {
      const snap = (
        window as unknown as { __taskvilleMovement: () => Walker[] }
      ).__taskvilleMovement();
      const texts: Record<string, string> = {};
      for (const el of document.querySelectorAll<HTMLElement>("[data-testid=agent-label]")) {
        texts[el.dataset.agentId ?? ""] = el.children[1]?.textContent ?? "";
      }
      return { walkers: snap, statuses: texts };
    });
    const wrong: string[] = [];
    let checked = 0;
    for (const w of walkers.filter((x) => coreIds.includes(x.id) && !x.gone)) {
      const status = statuses[w.id] as keyof typeof STATUS_ACTIVITY | undefined;
      const activity = status === undefined ? undefined : STATUS_ACTIVITY[status];
      if (activity === undefined) continue;
      checked++;
      const want = DEFAULT_ACTIVITY_AREAS.activities[activity];
      const have = w.slotId?.split(":")[0] ?? null;
      if (have !== want) wrong.push(`${w.id} (${status}): slot ${w.slotId}, expected area ${want}`);
    }
    return checked === 0 ? ["no core agent has an activity that maps to an area"] : wrong;
  };
  await expect.poll(misplaced, { timeout: 20_000, intervals: [500] }).toEqual([]);

  if (process.env.E2E_SCREENSHOT) {
    await page.waitForTimeout(500);
    await page.screenshot({ path: process.env.E2E_SCREENSHOT });
  }
});
