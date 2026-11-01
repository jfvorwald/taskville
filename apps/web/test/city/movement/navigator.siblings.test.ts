import { describe, expect, it } from "vitest";
import {
  createNavigator,
  type NavAgent,
  type NavIntent,
  type Navigator,
} from "../../../src/city/movement/navigator.ts";

// M3.24 (roborev 5612 #2): two subagents of one parent with no mapped destination used to spawn
// at the identical parent anchor and stay stacked, because neither had a path to walk.

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

describe("sibling subagents without a mapped destination", () => {
  it("do not stay stacked on the parent's anchor once settled", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    nav.sync([work("p", "workshop")], { place: true });
    nav.tick(clock.t);
    nav.sync([
      work("p", "workshop"),
      work("s1", null, { parentId: "p" }),
      work("s2", null, { parentId: "p" }),
    ]);
    for (let i = 0; i < 1200; i++) {
      clock.t += 50;
      nav.tick(clock.t);
    }
    // The same minimum separation the navigator tests hold walkers to.
    expect(dist(must(nav, "s1"), must(nav, "s2"))).toBeGreaterThan(0.45);
  });
});
