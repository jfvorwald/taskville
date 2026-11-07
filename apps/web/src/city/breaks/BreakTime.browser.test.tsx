import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Bubbles } from "../../overlays/bubbles/Bubbles.tsx";
import { getSettingsStore } from "../../overlays/settings/store.ts";
import { breakEmote } from "../attention/emote.ts";
import { lightingController } from "../lighting/instance.ts";
import {
  breakPoint,
  dist,
  expectedPlan,
  type Harness,
  mountCity,
  overlayProps,
  plazaPoints,
  SECOND,
  stateOf,
  WAITING_SINCE,
} from "./harness.fixture.tsx";

// M9.08: the break plan wired into the live city (ticket #451). One agent, a pinned data-store
// clock, reduced motion (walks snap), always-day lighting (so the planner's night input is false).
// A waiting agent stays at its workstation for the seeded delay (60 to 120 s after its waiting
// record began), then stands at the break spot the planner picked. New work ends the break; a
// needs-you shows its "!" marker, its bubble and its label at once and stops at a plaza point.
// Run: pnpm exec vitest run --root ../.. --project @taskville/web-browser src/city/breaks/BreakTime
// (or from apps/web: pnpm test:browser src/city/breaks/BreakTime.browser)

const POLL = { timeout: 15_000, interval: 100 };
const NEAR = 0.15;

let city: Harness | undefined;
const mounted = async (...args: Parameters<typeof mountCity>) => {
  city = await mountCity(...args);
  return city;
};

beforeEach(() => {
  lightingController.setSetting("always-day");
  getSettingsStore().set("breakTime", true);
});
afterEach(async () => {
  await city?.unmount();
  city = undefined;
  lightingController.setSetting("cycle");
  getSettingsStore().set("breakTime", true);
});

/** Seats one agent at its workstation, turns it Waiting at WAITING_SINCE + 9 s, returns its seat. */
async function seatedAndWaiting(h: Harness) {
  const seat = h.at("a1");
  if (seat === undefined) throw new Error("a1 has no position");
  h.clock.now = WAITING_SINCE + 9 * SECOND;
  h.apply(stateOf({ a1: "waiting" }));
  await h.frames(3);
  return seat;
}

/** Moves the clock past the longest delay (120 s), into the agent's first break segment. */
async function intoFirstBreak(h: Harness) {
  h.clock.now = WAITING_SINCE + 125 * SECOND;
  const planned = expectedPlan(h.store, h.clock.now).agents.get("a1");
  if (planned === undefined) throw new Error("the pure planner has no break for a1 at +125 s");
  return planned;
}

describe("break time in the city", () => {
  it("keeps a waiting agent at its slot before the delay and sends it to its break spot after", async () => {
    const h = await mounted({ a1: "working" });
    const seat = await seatedAndWaiting(h);
    expect(seat.x === 0 && seat.z === 0).toBe(false);

    // 9 s into the wait: the planner has no break yet (the delay is at least 60 s).
    expect(expectedPlan(h.store, h.clock.now).agents.size).toBe(0);
    await new Promise((r) => setTimeout(r, 1500));
    expect(dist(h.at("a1") as { x: number; z: number }, seat)).toBeLessThan(NEAR);
    expect(h.labels.getSnapshot().find((r) => r.id === "a1")?.onBreak ?? false).toBe(false);

    const planned = await intoFirstBreak(h);
    const spot = breakPoint(planned);
    await expect
      .poll(() => dist(h.at("a1") as { x: number; z: number }, spot), POLL)
      .toBeLessThan(NEAR);
    expect(dist(spot, seat)).toBeGreaterThan(1);
    // The break emote replaces the waiting one while on break.
    expect(h.emotesOf("a1")).toContain(breakEmote(planned.activity));
    expect(h.emotesOf("a1")).not.toContain("...");
  }, 40_000);

  it("ends the break when new work arrives: the agent walks back to its workstation", async () => {
    const h = await mounted({ a1: "working" });
    const seat = await seatedAndWaiting(h);
    const planned = await intoFirstBreak(h);
    const spot = breakPoint(planned);
    await expect
      .poll(() => dist(h.at("a1") as { x: number; z: number }, spot), POLL)
      .toBeLessThan(NEAR);

    // A prompt is submitted: the agent works again.
    h.clock.now += 5 * SECOND;
    h.apply(stateOf({ a1: "working" }));
    await expect
      .poll(() => dist(h.at("a1") as { x: number; z: number }, seat), POLL)
      .toBeLessThan(NEAR);
    expect(h.labels.getSnapshot().find((r) => r.id === "a1")?.onBreak ?? false).toBe(false);
    expect(h.emotesOf("a1")).not.toContain(breakEmote(planned.activity));
  }, 40_000);

  it("shows a needs-you at once for an agent on break and stops it at a plaza safe point", async () => {
    const h = await mounted({ a1: "working" }, ({ store, anchors }) => (
      <Bubbles {...overlayProps(anchors)} store={store} />
    ));
    await seatedAndWaiting(h);
    const planned = await intoFirstBreak(h);
    const spot = breakPoint(planned);
    await expect
      .poll(() => dist(h.at("a1") as { x: number; z: number }, spot), POLL)
      .toBeLessThan(NEAR);
    await expect
      .poll(() => h.labels.getSnapshot().find((r) => r.id === "a1")?.onBreak, POLL)
      .toBe(true);

    // A permission request opens while the agent is at the bar, smoke corner or plaza.
    h.clock.now += 2 * SECOND;
    h.apply(stateOf({ a1: "waiting" }, { ids: ["a1"], openedAt: h.clock.now }));

    // The marker, the label and the bubble all follow the needs-you, without waiting for the walk.
    await expect
      .poll(() => h.labels.getSnapshot().find((r) => r.id === "a1")?.urgent, POLL)
      .toBe(true);
    expect(h.labels.getSnapshot().find((r) => r.id === "a1")?.onBreak ?? false).toBe(false);
    await expect.poll(() => h.emotesOf("a1"), POLL).toContain("!");
    await expect
      .poll(
        () =>
          document
            .querySelector('[data-testid="quip-bubble"][data-agent-id="a1"]')
            ?.getAttribute("data-level"),
        POLL,
      )
      .toBe("needs_you");
    // It stops at a plaza safe point (a plaza break node already is one), not back at its desk.
    await expect
      .poll(
        () => plazaPoints().some((p) => dist(p, h.at("a1") as { x: number; z: number }) < NEAR),
        POLL,
      )
      .toBe(true);
  }, 40_000);

  it("marks the world label of an agent on break, and only while it is on break", async () => {
    const h = await mounted({ a1: "working" });
    await seatedAndWaiting(h);
    expect(h.labels.getSnapshot().find((r) => r.id === "a1")?.status).toBe("Waiting");
    expect(h.labels.getSnapshot().find((r) => r.id === "a1")?.onBreak ?? false).toBe(false);
    await intoFirstBreak(h);
    await expect
      .poll(() => h.labels.getSnapshot().find((r) => r.id === "a1")?.onBreak, POLL)
      .toBe(true);
    // The recorded status text is untouched (constitution IV).
    expect(h.labels.getSnapshot().find((r) => r.id === "a1")?.status).toBe("Waiting");
  }, 40_000);
});
