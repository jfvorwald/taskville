import { describe, expect, it } from "vitest";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import {
  createNavigator,
  type NavAgent,
  type NavIntent,
  type Navigator,
} from "../../../src/city/movement/navigator.ts";

// M3.18 (#232): a queued, held walker at rest in line for area A that is moved to area B while
// held, skipped by releaseSlot when an A slot frees (so it leaves A's line), and then moved back
// to A and un-held, used to keep view.queued = true with no place in any line. It then read as
// "still in line for the same area" and waited forever, even with A slots free.

const L = CITY_LAYOUT;
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

/** Advances a fake clock in 50 ms frames. */
function run(nav: Navigator, clock: { t: number }, ms: number) {
  const end = clock.t + ms;
  while (clock.t < end) {
    clock.t += FRAME_MS;
    nav.tick(clock.t);
  }
}

/** Slot ids held across all agents; asserts no slot appears twice. */
function heldSlots(nav: Navigator): string[] {
  const ids = nav
    .list()
    .map((a) => a.slotId)
    .filter((s): s is string => s !== null);
  expect(new Set(ids).size, `slots held: ${ids.join(",")}`).toBe(ids.length);
  return ids;
}

describe("a held, queued walker that leaves and re-enters an area's line", () => {
  it("is handed a slot in A once one is free, instead of waiting queued forever", () => {
    const nav = createNavigator();
    const clock = { t: 0 };
    const labIds = ["a", "b", "c", "d"];
    const lab = labIds.map((id) => work(id, "test_lab"));

    // Test Lab is full (4 slots); e is the one walker in line, at rest there.
    nav.sync([...lab, work("e", "test_lab")], { place: true });
    nav.tick(clock.t);
    run(nav, clock, 5_000);
    expect(must(nav, "e").slotId).toBeNull();
    expect(must(nav, "e").queued).toBe(true);
    expect(must(nav, "e").state).toBe("waiting");

    // Held while in line: it stops right there and keeps its place in A's line.
    nav.sync([...lab, work("e", "test_lab", { hold: true })]);
    run(nav, clock, 1_000);
    expect(must(nav, "e").queued).toBe(true);

    // Held, it is moved to B (Review). The hold branch returns early: still in A's line.
    nav.sync([...lab, work("e", "review", { hold: true })]);
    run(nav, clock, 1_000);

    // An A slot frees (a goes to Dispatch). releaseSlot skips e (its area is no longer A) and
    // drops it from the line.
    const afterA = [work("a", "dispatch"), ...["b", "c", "d"].map((id) => work(id, "test_lab"))];
    nav.sync([...afterA, work("e", "review", { hold: true })]);
    run(nav, clock, 1_000);

    // Held, it is moved back to A, then the hold clears.
    nav.sync([...afterA, work("e", "test_lab", { hold: true })]);
    run(nav, clock, 1_000);
    nav.sync([...afterA, work("e", "test_lab")]);
    run(nav, clock, 1_000);

    // Invariant: nobody may stay queued while a slot in their area is free and no line exists
    // for it to be in. With test_lab holding 3 of 4 slots, e must not be parked as queued.
    const heldByLab = nav.list().filter((x) => x.slotId?.startsWith("test_lab:")).length;
    if (heldByLab < 4) {
      expect(
        must(nav, "e").queued && must(nav, "e").slotId === null,
        "e is marked queued with a free Test Lab slot and nobody ahead of it",
      ).toBe(false);
    }

    // Other agents leave A as well; however the fix orders it, e ends up on an A slot.
    nav.sync([
      work("a", "dispatch"),
      work("b", "dispatch"),
      work("c", "test_lab"),
      work("d", "test_lab"),
      work("e", "test_lab"),
    ]);
    run(nav, clock, 90_000);

    const e = must(nav, "e");
    expect(e.slotId, "e should hold a Test Lab slot").not.toBeNull();
    expect(e.slotId?.startsWith("test_lab:")).toBe(true);
    expect(e.queued).toBe(false);
    heldSlots(nav);
    expect(dist(e, slot(e.slotId as string))).toBeLessThan(1e-6);
    expect(e.state).toBe("working");
  });
});
