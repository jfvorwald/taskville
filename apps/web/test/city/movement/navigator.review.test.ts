import { describe, expect, it } from "vitest";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import {
  createNavigator,
  type NavAgent,
  type NavIntent,
  type Navigator,
} from "../../../src/city/movement/navigator.ts";

// M3.06 code-review fixes (B1, S1, S4, N1). Each test pins a behavior the review found broken in
// the navigator; see the ticket's review notes.

const L = CITY_LAYOUT;
const SPEED = 1.6;
const FRAME_MS = 50;
const slot = (id: string) => {
  const s = L.slots.find((x) => x.id === id);
  if (!s) throw new Error(`no slot ${id}`);
  return s;
};
const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);
const must = (nav: Navigator, id: string): NavAgent => {
  const a = nav.get(id);
  if (!a) throw new Error(`no agent ${id}`);
  return a;
};
const work = (id: string, area: NavIntent["area"], extra: Partial<NavIntent> = {}): NavIntent => ({
  id,
  area,
  rest: "working",
  ...extra,
});

/** Advances a fake clock in 50 ms frames, calling `each` after every frame. */
function run(nav: Navigator, clock: { t: number }, ms: number, each?: () => void) {
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += FRAME_MS;
    nav.tick(clock.t);
    each?.();
  }
}

const plazaNodes = L.graph.nodes.filter((n) => n.kind === "plaza");
const onPlazaNode = (a: { x: number; z: number }) => plazaNodes.some((n) => dist(n, a) < 1e-6);

/** Slot ids held across all agents; asserts no slot appears twice and no agent holds two. */
function heldSlots(nav: Navigator): string[] {
  const ids = nav
    .list()
    .map((a) => a.slotId)
    .filter((s): s is string => s !== null);
  expect(new Set(ids).size, `slots held: ${ids.join(",")}`).toBe(ids.length);
  return ids;
}

/** Distance from a point to the nearest street edge of the graph. */
function distToStreets(p: { x: number; z: number }): number {
  let best = Number.POSITIVE_INFINITY;
  for (const e of L.graph.edges) {
    const a = L.graph.nodes.find((n) => n.id === e.from);
    const b = L.graph.nodes.find((n) => n.id === e.to);
    if (!a || !b) continue;
    const dx = b.x - a.x;
    const dz = b.z - a.z;
    const len2 = dx * dx + dz * dz;
    const t =
      len2 === 0 ? 0 : Math.max(0, Math.min(1, ((p.x - a.x) * dx + (p.z - a.z) * dz) / len2));
    best = Math.min(best, Math.hypot(p.x - (a.x + t * dx), p.z - (a.z + t * dz)));
  }
  return best;
}

describe("B1: an agent that changes area while queued", () => {
  const fullLab = () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    const ids = ["a", "b", "c", "d", "e", "f"];
    nav.sync(
      ids.map((id) => work(id, "test_lab")),
      { place: true },
    );
    nav.tick(clock.t);
    expect(must(nav, "e").queued).toBe(true);
    expect(must(nav, "f").queued).toBe(true);
    return { nav, clock };
  };

  it("leaves the old line, so a freed slot goes to the real head of the line", () => {
    const { nav, clock } = fullLab();

    // e gives up on Test Lab and goes to Review.
    nav.sync([...["a", "b", "c", "d", "f"].map((id) => work(id, "test_lab")), work("e", "review")]);
    expect(must(nav, "e").slotId).toBe("review:0");
    expect(must(nav, "e").queued).toBe(false);
    expect(must(nav, "f").queued).toBe(true);

    // A Test Lab slot frees up (a goes to Dispatch): f, the only one left in line, gets it.
    nav.sync([
      work("a", "dispatch"),
      ...["b", "c", "d", "f"].map((id) => work(id, "test_lab")),
      work("e", "review"),
    ]);
    expect(must(nav, "f").slotId).toBe("test_lab:0");
    expect(must(nav, "f").queued).toBe(false);
    // e keeps exactly the Review slot; its goal was not turned back to Test Lab.
    expect(must(nav, "e").slotId).toBe("review:0");
    heldSlots(nav);

    run(nav, clock, 90_000);
    expect(dist(must(nav, "e"), slot("review:0"))).toBeLessThan(1e-6);
    expect(dist(must(nav, "f"), slot("test_lab:0"))).toBeLessThan(1e-6);
    expect(dist(must(nav, "a"), slot("dispatch:0"))).toBeLessThan(1e-6);
    heldSlots(nav);
  });

  it("never lets an agent hold two slots across A, then B, then A again", () => {
    const { nav, clock } = fullLab();
    const lab = ["a", "b", "c", "d"].map((id) => work(id, "test_lab"));
    const rest = (area: NavIntent["area"]) => [work("e", area), work("f", "test_lab")];

    // e: Test Lab (queued), then Review (holds review:0), then Test Lab again (queued again).
    nav.sync([...lab, ...rest("review")]);
    heldSlots(nav);
    nav.sync([...lab, ...rest("test_lab")]);
    heldSlots(nav);
    expect(must(nav, "e").slotId).toBeNull();
    expect(must(nav, "e").queued).toBe(true);

    // Three Test Lab slots free up. Two agents are in line, so exactly two take a slot each and
    // one slot stays free: a stale second place in the line must not hand e a second slot.
    const leaving = [
      work("a", "dispatch"),
      work("b", "dispatch"),
      work("c", "dispatch"),
      work("d", "test_lab"),
    ];
    nav.sync([...leaving, ...rest("test_lab")]);
    const e = must(nav, "e");
    const f = must(nav, "f");
    expect(e.slotId).not.toBeNull();
    expect(f.slotId).not.toBeNull();
    expect(e.slotId).not.toBe(f.slotId);
    expect(e.queued).toBe(false);
    expect(f.queued).toBe(false);
    heldSlots(nav);

    // A newcomer takes the remaining free Test Lab slot (it was not swallowed by e), and the
    // Review slot e gave up is free for someone else.
    nav.sync([...leaving, ...rest("test_lab"), work("g", "test_lab"), work("h", "review")]);
    const g = must(nav, "g");
    expect(g.slotId).not.toBeNull();
    expect(g.queued).toBe(false);
    expect(must(nav, "h").slotId).toBe("review:0");
    const lab4 = ["d", "e", "f", "g"].map((id) => must(nav, id).slotId);
    expect(new Set(lab4).size).toBe(4);
    for (const id of lab4) expect(id?.startsWith("test_lab:")).toBe(true);

    run(nav, clock, 90_000);
    heldSlots(nav);
    // Everyone stands on a distinct slot of their own.
    const standing = nav.list().filter((a) => a.slotId !== null);
    expect(standing).toHaveLength(8);
    for (const a of standing) {
      expect(dist(a, slot(a.slotId as string)), a.id).toBeLessThan(1e-6);
    }
  });
});

describe("S1: a subagent spawned at its parent's building", () => {
  it("walks the street graph from the parent's anchor, never cutting across blocks", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    nav.sync([work("p", "workshop")], { place: true });
    nav.tick(clock.t);
    nav.sync([work("p", "workshop"), work("s", "archives", { parentId: "p" })]);
    nav.tick(clock.t);

    // Position on the street centerline is within the walking lane offset of a street edge.
    const lane = 0.3;
    const slack = 0.1;
    let prev = { x: must(nav, "s").x, z: must(nav, "s").z };
    let worstOffStreet = distToStreets(prev);
    let worstStep = 0;
    run(nav, clock, 90_000, () => {
      const s = must(nav, "s");
      worstStep = Math.max(worstStep, dist(prev, s));
      worstOffStreet = Math.max(worstOffStreet, distToStreets(s));
      prev = { x: s.x, z: s.z };
    });
    expect(worstOffStreet).toBeLessThan(lane + slack);
    // Per-frame displacement stays at walking speed (the lane offset eases, hence the margin).
    expect(worstStep).toBeLessThan((SPEED * FRAME_MS) / 1000 + 0.2);
    expect(dist(must(nav, "s"), slot("archives:0"))).toBeLessThan(1e-6);
  });
});

describe("S4: a held, queued walker that is handed a slot", () => {
  it("keeps exactly one plaza safe node, and gives it back when released", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    const lab = ["a", "b", "c", "d"].map((id) => work(id, "test_lab"));
    nav.sync(lab, { place: true });
    nav.tick(clock.t);

    // w is already held at a plaza point (the one on e's way). e then walks to line up for the
    // full Test Lab and is held mid-walk, so it takes another plaza point on its way to it.
    const holdW = work("w", "review", { hold: true });
    nav.sync([holdW, ...lab, work("e", "test_lab")]);
    run(nav, clock, 4_500);
    expect(must(nav, "e").queued).toBe(true);
    expect(must(nav, "e").onTheWay).toBe(true);
    nav.sync([holdW, ...lab, work("e", "test_lab", { hold: true })]);
    run(nav, clock, 250);

    // w is answered (its plaza point is free again) and d leaves in the same update: the freed
    // slot goes to e, which is still held and still walking to its safe point.
    const after = [
      work("w", "review"),
      ...["a", "b", "c"].map((id) => work(id, "test_lab")),
      work("d", "dispatch"),
    ];
    nav.sync([...after, work("e", "test_lab", { hold: true })]);
    expect(must(nav, "e").slotId).toBe("test_lab:3");
    run(nav, clock, 60_000);
    const e = must(nav, "e");
    expect(e.state).toBe("stuck");
    expect(onPlazaNode(e)).toBe(true);
    expect(e.slotId).toBe("test_lab:3");

    // Answered: e walks to its slot and gives its plaza point back.
    nav.sync([...after, work("e", "test_lab")]);
    run(nav, clock, 90_000);
    expect(dist(must(nav, "e"), slot("test_lab:3"))).toBeLessThan(1e-6);

    // Nothing leaked: five other agents, held one after another, get five distinct plaza points
    // (there are only five).
    const areas = ["workshop", "review", "security", "archives", "dispatch"] as const;
    const heldIds: string[] = [];
    for (const [i] of areas.entries()) {
      heldIds.push(`h${i}`);
      nav.sync([
        ...after,
        work("e", "test_lab"),
        ...heldIds.map((x, j) => work(x, areas[j] ?? null, { hold: true })),
      ]);
      run(nav, clock, 90_000);
    }
    const spots = heldIds.map((id) => must(nav, id));
    for (const h of spots) {
      expect(onPlazaNode(h), `${h.id} at (${h.x}, ${h.z})`).toBe(true);
      expect(h.state).toBe("stuck");
    }
    const keys = new Set(spots.map((h) => `${h.x.toFixed(3)},${h.z.toFixed(3)}`));
    expect(keys.size).toBe(5);
  });
});

describe("N1: the first snapshot with a held agent", () => {
  it("places a needs-you agent at its workstation, not at a plaza safe node", () => {
    const nav = createNavigator();
    nav.sync([work("a", "workshop", { hold: true })], { place: true });
    nav.tick(0);
    const a = must(nav, "a");
    expect(a.slotId).toBe("workshop:0");
    expect(dist(a, slot("workshop:0"))).toBeLessThan(1e-6);
    expect(a.onTheWay).toBe(false);
    expect(a.state).toBe("stuck");
  });
});
