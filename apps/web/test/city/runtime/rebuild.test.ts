import { describe, expect, it } from "vitest";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import { createNavigator, type Navigator } from "../../../src/city/movement/navigator.ts";
import { rebuildPresentation } from "../../../src/city/runtime/rebuild.ts";

// M3.14 code-review fix (B1). ARCHITECTURE.md section 2.8: "If the browser tab is hidden,
// animation pauses and the presentation is rebuilt on return." The pacer only restarts its loop;
// `rebuildPresentation` is the pure step that snaps walkers to the end of their paths after a
// long absence (reduced motion on for one tick, then the user's preference restored).

const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

function walkingNav(reduced = false) {
  const nav = createNavigator({ reducedMotion: reduced });
  nav.sync([{ id: "a", area: "workshop", rest: "working" }]);
  let t = 0;
  nav.tick(t);
  while (t < 2_500) {
    t += 50;
    nav.tick(t);
  }
  return { nav, t };
}

const must = (nav: Navigator, id: string) => {
  const a = nav.get(id);
  if (!a) throw new Error(`no agent ${id}`);
  return a;
};
const slot = () => {
  const s = CITY_LAYOUT.slots.find((x) => x.id === "workshop:0");
  if (!s) throw new Error("no slot workshop:0");
  return s;
};

describe("rebuildPresentation", () => {
  it("setup: the agent is mid-walk before the rebuild", () => {
    const { nav } = walkingNav();
    const a = must(nav, "a");
    expect(a.onTheWay).toBe(true);
    expect(["arriving", "walking"]).toContain(a.state);
    expect(dist(a, slot())).toBeGreaterThan(1);
  });

  it("snaps walkers to their destination after a long absence", () => {
    const { nav, t } = walkingNav();
    rebuildPresentation(nav, t + 60_000, false, 60_000);
    const a = must(nav, "a");
    expect(dist(a, slot())).toBeLessThan(1e-6);
    expect(a.state).toBe("working");
    expect(a.onTheWay).toBe(false);
  });

  it("restores a reduced-motion preference of false afterwards (later walks are animated)", () => {
    const { nav, t } = walkingNav(false);
    rebuildPresentation(nav, t + 60_000, false, 60_000);
    nav.sync([
      { id: "a", area: "workshop", rest: "working" },
      { id: "b", area: "library", rest: "working" },
    ]);
    nav.tick(t + 60_000);
    nav.tick(t + 60_100);
    const b = must(nav, "b");
    expect(b.onTheWay).toBe(true);
    expect(["arriving", "walking"]).toContain(b.state);
  });

  it("restores a reduced-motion preference of true afterwards (later walks still snap)", () => {
    const { nav, t } = walkingNav(true);
    rebuildPresentation(nav, t + 60_000, true, 60_000);
    nav.sync([{ id: "b", area: "library", rest: "working" }]);
    nav.tick(t + 60_100);
    const b = must(nav, "b");
    expect(b.onTheWay).toBe(false);
    expect(b.state).toBe("working");
  });

  it("does nothing for a short absence: the agent keeps walking", () => {
    const { nav, t } = walkingNav();
    const before = { ...must(nav, "a") };
    rebuildPresentation(nav, t + 500, false, 500);
    const a = must(nav, "a");
    expect(a.onTheWay).toBe(true);
    expect(["arriving", "walking"]).toContain(a.state);
    expect(dist(a, before)).toBeLessThan(1e-9);
  });

  it("rebuilds at exactly 2000 ms and not at 1999 ms", () => {
    const short = walkingNav();
    rebuildPresentation(short.nav, short.t + 1_999, false, 1_999);
    expect(must(short.nav, "a").onTheWay).toBe(true);

    const edge = walkingNav();
    rebuildPresentation(edge.nav, edge.t + 2_000, false, 2_000);
    expect(must(edge.nav, "a").onTheWay).toBe(false);
  });
});
