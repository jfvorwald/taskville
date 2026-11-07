import { describe, expect, it } from "vitest";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import type { MovementLabel } from "../../../src/city/movement/labels.ts";
import {
  type BreakDestination,
  createNavigator,
  type NavAgent,
  type NavIntent,
  type Navigator,
} from "../../../src/city/movement/navigator.ts";
import { motionSignals } from "../../../src/city/runtime/motion-signals.ts";

// Break trips (break time design, M9.05). An agent whose recorded state is Waiting may carry a
// `breakSpot`: it walks from its workstation to a break site spot or a plaza node and stands
// there, still presenting its rest state. The slot stays reserved. Removing the spot, new work or
// needs-you ends the break with the existing navigator rules.

const L = CITY_LAYOUT;
const slot = (id: string) => {
  const s = L.slots.find((x) => x.id === id);
  if (!s) throw new Error(`no slot ${id}`);
  return s;
};
const site = L.breakSites[0];
const spot = site?.spots[0];
if (!site || !spot) throw new Error("layout has no break spot");
const BAR: BreakDestination = { kind: "site", nodeId: spot.nodeId };
const plazaNodes = L.graph.nodes.filter((n) => n.kind === "plaza");
const PLAZA_BREAK: BreakDestination = { kind: "plaza", index: 1 };
const plazaPoint = plazaNodes[1] as (typeof plazaNodes)[number];

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);
const must = (nav: Navigator, id: string): NavAgent => {
  const a = nav.get(id);
  if (!a) throw new Error(`no agent ${id}`);
  return a;
};
function run(nav: Navigator, clock: { t: number }, ms: number, each?: () => void) {
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += 50;
    nav.tick(clock.t);
    each?.();
  }
}
const waiting = (
  id: string,
  area: NavIntent["area"],
  extra: Partial<NavIntent> = {},
): NavIntent => ({
  id,
  area,
  rest: "waiting",
  ...extra,
});
const isWalking = (a: NavAgent) =>
  a.state === "walking" || a.state === "arriving" || a.state === "departing";

/** An agent seated at workshop:0, waiting, with the clock at 0. */
function seated() {
  const nav = createNavigator();
  const clock = { t: 0 };
  nav.sync([waiting("a", "workshop")], { place: true });
  nav.tick(clock.t);
  return { nav, clock };
}

describe("navigator break trips", () => {
  it("walks from its slot to a break site spot and stands there, still waiting", () => {
    const { nav, clock } = seated();
    expect(dist(must(nav, "a"), slot("workshop:0"))).toBeLessThan(1e-6);
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 1_000);
    expect(must(nav, "a").state).toBe("walking");

    run(nav, clock, 90_000);
    const a = must(nav, "a");
    expect(dist(a, spot)).toBeLessThan(1e-6);
    expect(a.state).toBe("waiting");
    expect(a.onTheWay).toBe(false);
    // The workstation stays reserved for the way back.
    expect(a.slotId).toBe("workshop:0");
  });

  it("walks to a plaza node for a stroll or chat", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: PLAZA_BREAK })]);
    run(nav, clock, 90_000);
    expect(dist(must(nav, "a"), plazaPoint)).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("waiting");
  });

  it("does not move while standing at a break spot", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    const before = { x: must(nav, "a").x, z: must(nav, "a").z };
    run(nav, clock, 10_000, () => {
      expect(dist(must(nav, "a"), before)).toBeLessThan(1e-9);
      expect(isWalking(must(nav, "a"))).toBe(false);
    });
  });

  it("does not count a standing break as moving for the idle throttle", () => {
    const { nav, clock } = seated();
    const labels = (): MovementLabel[] => {
      const a = must(nav, "a");
      return [
        {
          id: "a",
          name: "a",
          status: "Waiting",
          onTheWay: a.onTheWay,
          state: a.state,
          urgent: false,
        },
      ];
    };
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 1_000);
    expect(motionSignals(labels(), false, false).agentsMoving).toBe(true);
    run(nav, clock, 90_000);
    expect(motionSignals(labels(), false, false).agentsMoving).toBe(false);
  });

  it("walks back to its slot when the break destination is removed", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    nav.sync([waiting("a", "workshop")]);
    nav.tick(clock.t + 50);
    clock.t += 50;
    expect(must(nav, "a").state).toBe("walking");
    run(nav, clock, 90_000);
    const a = must(nav, "a");
    expect(dist(a, slot("workshop:0"))).toBeLessThan(1e-6);
    expect(a.slotId).toBe("workshop:0");
    expect(a.state).toBe("waiting");
  });

  it("goes to a plaza safe point when needs-you arrives mid-walk, then back to its slot", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 1_500);
    nav.sync([waiting("a", "workshop", { hold: true })]);
    run(nav, clock, 90_000);
    const held = must(nav, "a");
    expect(held.state).toBe("stuck");
    expect(plazaNodes.some((n) => dist(n, held) < 1e-6)).toBe(true);

    // The break is over: it returns to its workstation, not to the bar.
    nav.sync([waiting("a", "workshop")]);
    run(nav, clock, 90_000);
    expect(dist(must(nav, "a"), slot("workshop:0"))).toBeLessThan(1e-6);
  });

  it("leaves a break spot for a plaza safe point on needs-you", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    nav.sync([waiting("a", "workshop", { hold: true })]);
    run(nav, clock, 90_000);
    const held = must(nav, "a");
    expect(held.state).toBe("stuck");
    expect(plazaNodes.some((n) => dist(n, held) < 1e-6)).toBe(true);
  });

  it("stays put when needs-you arrives at a plaza break node", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: PLAZA_BREAK })]);
    run(nav, clock, 90_000);
    nav.sync([waiting("a", "workshop", { hold: true })]);
    run(nav, clock, 10_000);
    expect(dist(must(nav, "a"), plazaPoint)).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("stuck");
  });

  it("returns to the break spot when hold clears and the intent still carries it", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    nav.sync([waiting("a", "workshop", { hold: true, breakSpot: BAR })]);
    run(nav, clock, 90_000);
    expect(plazaNodes.some((n) => dist(n, must(nav, "a")) < 1e-6)).toBe(true);
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    expect(dist(must(nav, "a"), spot)).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("waiting");
  });

  it("cancels the break and walks to the new area when work arrives elsewhere", () => {
    const { nav, clock } = seated();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    run(nav, clock, 90_000);
    nav.sync([{ id: "a", area: "archives", rest: "working", breakSpot: BAR }]);
    expect(must(nav, "a").slotId).toBe("archives:0");
    run(nav, clock, 120_000);
    const a = must(nav, "a");
    expect(dist(a, slot("archives:0"))).toBeLessThan(1e-6);
    expect(a.state).toBe("working");
  });

  it("places a new agent with a break destination straight at the spot (history)", () => {
    const nav = createNavigator();
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })], { place: true });
    nav.tick(0);
    const a = must(nav, "a");
    expect(dist(a, spot)).toBeLessThan(1e-6);
    expect(a.state).toBe("waiting");
    expect(a.slotId).toBe("workshop:0");
  });

  it("snaps break trips under reduced motion", () => {
    const nav = createNavigator({ reducedMotion: true });
    nav.sync([waiting("a", "workshop")], { place: true });
    nav.tick(0);
    nav.sync([waiting("a", "workshop", { breakSpot: BAR })]);
    nav.tick(16);
    expect(dist(must(nav, "a"), spot)).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("waiting");
    nav.sync([waiting("a", "workshop")]);
    nav.tick(32);
    expect(dist(must(nav, "a"), slot("workshop:0"))).toBeLessThan(1e-6);
  });
});
