import { describe, expect, it } from "vitest";
import { CITY_LAYOUT, nodeById } from "../../../src/city/layout/index.ts";
import {
  createNavigator,
  type NavAgent,
  type NavIntent,
  type Navigator,
} from "../../../src/city/movement/navigator.ts";

const L = CITY_LAYOUT;
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

/** Advances a fake clock in 50 ms frames, calling `each` after every frame. */
function run(nav: Navigator, clock: { t: number }, ms: number, each?: () => void) {
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += 50;
    nav.tick(clock.t);
    each?.();
  }
}

const work = (id: string, area: NavIntent["area"], extra: Partial<NavIntent> = {}): NavIntent => ({
  id,
  area,
  rest: "working",
  ...extra,
});

describe("navigator", () => {
  it("walks a new agent from the plaza to a reserved slot, on the way until it arrives", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    nav.sync([work("a", "workshop")]);
    nav.tick(clock.t);
    const start = must(nav, "a");
    expect(start.slotId).toBe("workshop:0");
    expect(start.state).toBe("arriving");
    expect(start.onTheWay).toBe(true);
    expect(nodeById(L, "plaza:center")).toBeDefined();
    expect(Math.abs(start.x) <= L.plaza.half && Math.abs(start.z) <= L.plaza.half).toBe(true);

    run(nav, clock, 60_000);
    const done = must(nav, "a");
    expect(dist(done, slot("workshop:0"))).toBeLessThan(1e-6);
    expect(done.heading).toBeCloseTo(slot("workshop:0").facing);
    expect(done.state).toBe("working");
    expect(done.onTheWay).toBe(false);
  });

  it("replans from where it is when new work interrupts a walk", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    nav.sync([work("a", "workshop")]);
    run(nav, clock, 2_500);
    const mid = must(nav, "a");
    expect(mid.onTheWay).toBe(true);
    const before = { x: mid.x, z: mid.z };

    // New work: Archives is the other way. The workshop slot is released at once.
    nav.sync([work("a", "archives")]);
    nav.sync([work("a", "archives"), work("b", "workshop")]);
    expect(must(nav, "a").slotId).toBe("archives:0");
    expect(must(nav, "b").slotId).toBe("workshop:0");

    // It never reaches the workshop first: its distance to Workshop only grows from here.
    let nearestWorkshop = dist(before, slot("workshop:0"));
    run(nav, clock, 60_000, () => {
      nearestWorkshop = Math.min(nearestWorkshop, dist(must(nav, "a"), slot("workshop:0")));
    });
    expect(nearestWorkshop).toBeGreaterThan(dist(before, slot("workshop:0")) - 0.6);
    const done = must(nav, "a");
    expect(dist(done, slot("archives:0"))).toBeLessThan(1e-6);
    expect(done.state).toBe("working");
    expect(dist(must(nav, "b"), slot("workshop:0"))).toBeLessThan(1e-6);
  });

  it("queues agents when an area's slots are full, then hands a freed slot to the first in line", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    const ids = ["a", "b", "c", "d", "e", "f"];
    nav.sync(ids.map((id) => work(id, "test_lab")), { place: true });
    nav.tick(clock.t);

    const slots = ids.slice(0, 4).map((id) => must(nav, id).slotId);
    expect(slots).toEqual(["test_lab:0", "test_lab:1", "test_lab:2", "test_lab:3"]);
    for (const id of ["e", "f"]) {
      const q = must(nav, id);
      expect(q.slotId).toBeNull();
      expect(q.queued).toBe(true);
      expect(q.state).toBe("waiting");
    }
    // Queue spots are distinct, off the slots, and near the area.
    const e = must(nav, "e");
    const f = must(nav, "f");
    expect(dist(e, f)).toBeGreaterThan(0.6);
    for (const s of L.slots.filter((x) => x.areaId === "test_lab")) {
      expect(dist(e, s)).toBeGreaterThan(0.6);
      expect(dist(f, s)).toBeGreaterThan(0.6);
    }
    const area = L.areas.find((a) => a.id === "test_lab");
    const anchor = area && nodeById(L, area.anchorId);
    if (!anchor) throw new Error("no anchor");
    expect(dist(e, anchor)).toBeLessThan(5);

    // b leaves for Review: e (first in line) takes test_lab:1, f stays queued.
    nav.sync([
      work("a", "test_lab"),
      work("b", "review"),
      ...["c", "d", "e", "f"].map((id) => work(id, "test_lab")),
    ]);
    expect(must(nav, "e").slotId).toBe("test_lab:1");
    expect(must(nav, "e").queued).toBe(false);
    expect(must(nav, "f").queued).toBe(true);
    run(nav, clock, 60_000);
    expect(dist(must(nav, "e"), slot("test_lab:1"))).toBeLessThan(1e-6);
    expect(must(nav, "e").state).toBe("working");
    expect(dist(must(nav, "b"), slot("review:0"))).toBeLessThan(1e-6);
  });

  it("snaps to the destination with reduced motion", () => {
    const nav = createNavigator({ reducedMotion: true });
    nav.sync([work("a", "review")]);
    nav.tick(0);
    const a = must(nav, "a");
    expect(dist(a, slot("review:0"))).toBeLessThan(1e-6);
    expect(a.onTheWay).toBe(false);
    expect(a.state).toBe("working");

    // A replan snaps too, and turning reduced motion on mid-walk snaps the walker.
    nav.sync([work("a", "dispatch")]);
    nav.tick(16);
    expect(dist(must(nav, "a"), slot("dispatch:0"))).toBeLessThan(1e-6);

    const moving = createNavigator();
    moving.sync([work("b", "security")]);
    moving.tick(0);
    moving.tick(1_000);
    expect(must(moving, "b").onTheWay).toBe(true);
    moving.setReducedMotion(true);
    moving.tick(1_016);
    expect(dist(must(moving, "b"), slot("security:0"))).toBeLessThan(1e-6);
  });

  it("places agents directly at their destination for the first snapshot", () => {
    const nav = createNavigator();
    nav.sync([work("a", "archives"), work("b", "archives")], { place: true });
    nav.tick(0);
    expect(dist(must(nav, "a"), slot("archives:0"))).toBeLessThan(1e-6);
    expect(dist(must(nav, "b"), slot("archives:1"))).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("working");
  });

  it("stops a needs-you agent at the nearest free safe point, then resumes", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    nav.sync([work("a", "review"), work("b", "review")]);
    run(nav, clock, 1_500);
    nav.sync([work("a", "review", { hold: true }), work("b", "review", { hold: true })]);
    run(nav, clock, 30_000);
    const a = must(nav, "a");
    const b = must(nav, "b");
    for (const held of [a, b]) {
      expect(held.state).toBe("stuck");
      expect(held.onTheWay).toBe(false);
      const plaza = L.graph.nodes.filter((n) => n.kind === "plaza");
      expect(plaza.some((n) => dist(n, held) < 1e-6)).toBe(true);
    }
    expect(dist(a, b)).toBeGreaterThan(0.6);
    // It keeps its slot while held, and walks on when the request is answered.
    expect(a.slotId).toBe("review:0");
    nav.sync([work("a", "review"), work("b", "review")]);
    run(nav, clock, 60_000);
    expect(dist(must(nav, "a"), slot("review:0"))).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("working");
  });

  it("holds an agent that is already at its workstation where it is", () => {
    const nav = createNavigator();
    nav.sync([work("a", "workshop")], { place: true });
    nav.tick(0);
    nav.sync([work("a", "workshop", { hold: true })]);
    nav.tick(1_000);
    expect(dist(must(nav, "a"), slot("workshop:0"))).toBeLessThan(1e-6);
    expect(must(nav, "a").state).toBe("stuck");
  });

  it("keeps the current destination when the activity names none, and shows the rest state", () => {
    const nav = createNavigator();
    nav.sync([work("a", "workshop")], { place: true });
    nav.tick(0);
    nav.sync([{ id: "a", area: null, rest: "waiting" }]);
    nav.tick(100);
    expect(must(nav, "a").slotId).toBe("workshop:0");
    expect(must(nav, "a").state).toBe("waiting");
    nav.sync([{ id: "a", area: null, rest: "idle" }]);
    nav.tick(200);
    expect(must(nav, "a").state).toBe("idle");

    // A new agent with nowhere to go idles at the plaza.
    nav.sync([{ id: "a", area: null, rest: "idle" }, { id: "n", area: null, rest: "idle" }]);
    nav.tick(300);
    const n = must(nav, "n");
    expect(n.state).toBe("idle");
    expect(n.slotId).toBeNull();
    expect(Math.abs(n.x) <= L.plaza.half && Math.abs(n.z) <= L.plaza.half).toBe(true);
  });

  it("departs an agent that left, frees its slot, and reports it gone at the exit", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    nav.sync([work("a", "dispatch")], { place: true });
    nav.tick(0);
    nav.sync([]);
    nav.sync([work("b", "dispatch")]);
    expect(must(nav, "b").slotId).toBe("dispatch:0");
    nav.tick(clock.t);
    expect(must(nav, "a").state).toBe("departing");
    expect(must(nav, "a").onTheWay).toBe(false);
    run(nav, clock, 60_000);
    expect(must(nav, "a").gone).toBe(true);
    expect(nav.list().map((x) => x.id)).toEqual(["a", "b"]);
    nav.prune();
    expect(nav.list().map((x) => x.id)).toEqual(["b"]);
  });

  it("spawns a subagent at its parent's building and keeps spacing between walkers", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    nav.sync([work("p", "workshop")], { place: true });
    nav.tick(0);
    nav.sync([work("p", "workshop"), work("s", "archives", { parentId: "p" })]);
    nav.tick(0);
    const area = L.areas.find((a) => a.id === "workshop");
    const anchor = area && nodeById(L, area.anchorId);
    if (!anchor) throw new Error("no anchor");
    expect(dist(must(nav, "s"), anchor)).toBeLessThan(1e-6);

    // Six agents set off at once for areas on the same side; while two walk, they keep apart.
    const walkers = ["a", "b", "c", "d", "e", "f"];
    const areas = ["workshop", "test_lab", "review", "workshop", "test_lab", "review"] as const;
    const nav2 = createNavigator();
    const c2 = { t: 0 };
    nav2.sync(walkers.map((id, i) => work(id, areas[i] ?? null)));
    let closest = Number.POSITIVE_INFINITY;
    run(nav2, c2, 60_000, () => {
      const all = nav2.list();
      for (let i = 0; i < all.length; i++) {
        for (let j = i + 1; j < all.length; j++) {
          const p = all[i];
          const q = all[j];
          if (p && q && (p.onTheWay || q.onTheWay)) closest = Math.min(closest, dist(p, q));
        }
      }
    });
    expect(closest).toBeGreaterThan(0.45);
    for (const id of walkers) expect(must(nav2, id).state).toBe("working");
  });

  it("is deterministic for a given clock", () => {
    const script = (nav: Navigator) => {
      const out: string[] = [];
      nav.sync([work("a", "workshop"), work("b", "workshop"), work("c", "security")]);
      for (let t = 0; t <= 20_000; t += 33) {
        if (t === 4_983) nav.sync([work("a", "archives"), work("b", "workshop"), work("c", "review")]);
        nav.tick(t);
        for (const x of nav.list()) out.push(`${x.id}:${x.x.toFixed(6)}:${x.z.toFixed(6)}:${x.state}`);
      }
      return out.join("|");
    };
    expect(script(createNavigator())).toBe(script(createNavigator()));
  });
});
