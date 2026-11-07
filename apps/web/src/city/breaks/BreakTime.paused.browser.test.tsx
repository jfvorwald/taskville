import { afterEach, beforeEach, expect, it } from "vitest";
import { PROJECT } from "../../../test/data/fake-engine.ts";
import { createDataStore } from "../../data/store.ts";
import { Bubbles } from "../../overlays/bubbles/Bubbles.tsx";
import { getSettingsStore } from "../../overlays/settings/store.ts";
import { lightingController } from "../lighting/instance.ts";
import {
  expectedPlan,
  type Harness,
  mountCity,
  overlayProps,
  SECOND,
  stateOf,
  WAITING_SINCE,
} from "./harness.fixture.tsx";

// roborev 7349: in paused history the replay clock is fixed, so a chatter bubble must carry the
// replay clock's progress (now - turnStartedAt) as a paused negative animation delay, like the
// attention quips do (history/fidelity/PausedQuips). Otherwise its real-time 4 s fade runs.
// Run: pnpm test:browser src/city/breaks/BreakTime.paused  (from apps/web)

let city: Harness | undefined;
beforeEach(() => {
  lightingController.setSetting("always-day");
  getSettingsStore().set("breakTime", true);
});
afterEach(async () => {
  await city?.unmount();
  city = undefined;
  lightingController.setSetting("cycle");
});

it("gives a paused-history chatter bubble the replay clock's progress as its animation delay", async () => {
  const phases = { p1: "waiting", q1: "waiting" } as const;
  const at = WAITING_SINCE + 125 * SECOND;
  const probeStore = createDataStore({ now: () => at });
  probeStore.getState().reset(PROJECT);
  probeStore.getState().applySnapshotState(stateOf(phases));
  const probe = expectedPlan(probeStore, at).conversations[0];
  if (probe === undefined) {
    throw new Error("the pure planner has no conversation for p1 and q1 at this moment");
  }
  const elapsed = at - probe.turnStartedAt;

  const h = await mountCity(
    phases,
    ({ store, anchors }) => <Bubbles {...overlayProps(anchors)} mode="history" store={store} />,
    { now: at },
  );
  city = h;
  await h.frames(3);

  const bubble = () =>
    document.querySelector<HTMLElement>('[data-testid="quip-bubble"][data-level="chatter"]');
  await expect.poll(() => bubble() !== null, { timeout: 15_000 }).toBe(true);
  expect(bubble()?.style.animationPlayState).toBe("paused");
  expect(bubble()?.style.animationDelay).toBe(`-${elapsed}ms`);
}, 40_000);

// roborev 7351: in paused history, selecting an unpaired agent well into its break must show its
// activity bubble at its start (live shows a fresh 4 s bubble), not frozen past the end at opacity 0.
it("shows a selected unpaired agent's activity bubble visibly in paused history", async () => {
  const phases = { p1: "waiting" } as const;
  const at = WAITING_SINCE + 200 * SECOND;
  const probeStore = createDataStore({ now: () => at });
  probeStore.getState().reset(PROJECT);
  probeStore.getState().applySnapshotState(stateOf(phases));
  const onBreak = expectedPlan(probeStore, at).agents.get("p1");
  if (onBreak === undefined) {
    throw new Error("the pure planner has no break for p1 at this moment");
  }
  if (at - onBreak.startedAt < 10 * SECOND) {
    throw new Error("the fixed clock is not 10 s or more into p1's break segment");
  }

  const h = await mountCity(
    phases,
    ({ store, anchors }) => (
      <Bubbles {...overlayProps(anchors, "p1")} mode="history" store={store} />
    ),
    { now: at },
  );
  city = h;
  await h.frames(3);

  const bubble = () =>
    document.querySelector<HTMLElement>('[data-testid="quip-bubble"][data-level="activity"]');
  await expect.poll(() => bubble() !== null, { timeout: 15_000 }).toBe(true);
  expect(bubble()?.style.animationPlayState).toBe("paused");
  const delay = Number.parseFloat(bubble()?.style.animationDelay ?? "NaN");
  expect(delay).toBeGreaterThanOrEqual(-1000);
  expect(Number.parseFloat(getComputedStyle(bubble() as HTMLElement).opacity)).toBeGreaterThan(0);
}, 40_000);
