import { describe, expect, it, vi } from "vitest";
import type { Celebration } from "../../../src/city/effects/triggers.ts";
import { createCelebrations } from "../../../src/city/effects/triggers.ts";
import {
  demo,
  gitMerge,
  handoff,
  imported,
  late,
  taskCompleted,
  testGreen,
  testRed,
} from "./events.ts";

// Review findings on M3.13:
// 1. Only a celebration that was actually played starts the 2 s window. The renderer reports that
//    through the optional second argument of `handle(event, play)`: `play` receives the celebration
//    and returns true when it was drawn, false when it could not be (agent not placed, ...).
//    Omitting `play` means "assume played" (the existing behaviour).
// 2. Imported and late events never celebrate and never touch the red/green tracking.

function setup(opts: { reducedMotion?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const celebrations = createCelebrations({
    now: () => clock.now,
    reducedMotion: opts.reducedMotion ?? false,
  });
  return { clock, celebrations };
}

const drawn = (_c: Celebration) => true;
const notDrawn = (_c: Celebration) => false;

describe("a celebration that cannot be drawn does not start the rate-limit window", () => {
  it("passes the wanted celebration to play", () => {
    const { celebrations } = setup();
    const play = vi.fn(drawn);
    celebrations.handle(taskCompleted("a1"), play);
    expect(play).toHaveBeenCalledTimes(1);
    expect(play.mock.calls[0]?.[0]).toMatchObject({ kind: "confetti", agentId: "a1" });
  });

  it("a completion that was not drawn leaves the next completion 500 ms later free to play", () => {
    const { celebrations, clock } = setup();
    celebrations.handle(taskCompleted("unplaced"), notDrawn);
    clock.now += 500;
    const play = vi.fn(drawn);
    const out = celebrations.handle(taskCompleted("a2"), play);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "confetti", agentId: "a2" });
    expect(play).toHaveBeenCalledTimes(1);
  });

  it("a completion that was drawn still blocks the next one for 2 s", () => {
    const { celebrations, clock } = setup();
    celebrations.handle(taskCompleted("a1"), drawn);
    clock.now += 500;
    const play = vi.fn(drawn);
    expect(celebrations.handle(taskCompleted("a2"), play)).toEqual([]);
    expect(play).not.toHaveBeenCalled();
    clock.now += 1500;
    expect(celebrations.handle(taskCompleted("a3"), drawn)).toHaveLength(1);
  });

  it("a high-five that was not drawn does not start the window", () => {
    const { celebrations, clock } = setup();
    celebrations.handle(handoff("a1", "unplaced"), notDrawn);
    clock.now += 500;
    expect(celebrations.handle(taskCompleted("a2"), drawn)).toHaveLength(1);
  });

  it("a reduced-motion sparkle that was not drawn does not start the window", () => {
    const { celebrations, clock } = setup({ reducedMotion: true });
    const play = vi.fn(notDrawn);
    celebrations.handle(taskCompleted("unplaced"), play);
    expect(play.mock.calls[0]?.[0]).toMatchObject({ kind: "sparkle", source: "confetti" });
    clock.now += 500;
    expect(celebrations.handle(taskCompleted("a2"), drawn)).toHaveLength(1);
  });

  it("a shimmer that was not drawn does not start the window", () => {
    const { celebrations, clock } = setup();
    celebrations.handle(testRed("a1"));
    clock.now += 5000;
    celebrations.handle(testGreen("a1"), notDrawn);
    clock.now += 500;
    expect(celebrations.handle(gitMerge(), drawn)).toHaveLength(1);
  });

  it("several undrawn celebrations in a row never block a drawn one", () => {
    const { celebrations, clock } = setup();
    for (let i = 0; i < 3; i += 1) {
      celebrations.handle(taskCompleted(`unplaced-${i}`), notDrawn);
      clock.now += 100;
    }
    expect(celebrations.handle(taskCompleted("a1"), drawn)).toHaveLength(1);
  });
});

describe("imported and late events do not celebrate", () => {
  it.each([
    ["completion", () => taskCompleted("a1")],
    ["handoff", () => handoff("a1", "a2")],
    ["merge", () => gitMerge()],
  ])("an imported %s gives no celebration", (_name, build) => {
    const { celebrations } = setup();
    expect(celebrations.handle(imported(build()))).toEqual([]);
  });

  it.each([
    ["completion", () => taskCompleted("a1")],
    ["handoff", () => handoff("a1", "a2")],
    ["merge", () => gitMerge()],
  ])("a late %s gives no celebration", (_name, build) => {
    const { celebrations } = setup();
    expect(celebrations.handle(late(build()))).toEqual([]);
  });

  it("an imported or late completion gives no sparkle in reduced motion either", () => {
    const { celebrations } = setup({ reducedMotion: true });
    expect(celebrations.handle(imported(taskCompleted("a1")))).toEqual([]);
    expect(celebrations.handle(late(taskCompleted("a1")))).toEqual([]);
  });

  it("an imported or late completion does not call play", () => {
    const { celebrations } = setup();
    const play = vi.fn(drawn);
    celebrations.handle(imported(taskCompleted("a1")), play);
    celebrations.handle(late(taskCompleted("a1")), play);
    expect(play).not.toHaveBeenCalled();
  });

  it("an imported or late event does not use up the rate-limit window", () => {
    const { celebrations, clock } = setup();
    celebrations.handle(imported(taskCompleted("a1")));
    celebrations.handle(late(gitMerge()));
    clock.now += 100;
    expect(celebrations.handle(taskCompleted("a2"))).toHaveLength(1);
  });

  it("demo events still celebrate", () => {
    const { celebrations } = setup();
    expect(celebrations.handle(demo(taskCompleted("a1")))[0]).toMatchObject({ kind: "confetti" });
  });

  it("live events that are not late still celebrate", () => {
    const { celebrations } = setup();
    expect(celebrations.handle(taskCompleted("a1"))).toHaveLength(1);
  });

  describe("test results", () => {
    it("an imported green after a live red gives no shimmer", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(testRed("a1"));
      clock.now += 5000;
      expect(celebrations.handle(imported(testGreen("a1")))).toEqual([]);
    });

    it("a late green after a live red gives no shimmer", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(testRed("a1"));
      clock.now += 5000;
      expect(celebrations.handle(late(testGreen("a1")))).toEqual([]);
    });

    it("an imported or late green is ignored entirely: the live red stays armed for a later live green", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(testRed("a1"));
      clock.now += 5000;
      celebrations.handle(imported(testGreen("a1")));
      celebrations.handle(late(testGreen("a1")));
      clock.now += 5000;
      const out = celebrations.handle(testGreen("a1"));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: "shimmer", area: "test-lab" });
    });

    it("an imported red does not arm a later live green", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(imported(testRed("a1")));
      clock.now += 5000;
      expect(celebrations.handle(testGreen("a1"))).toEqual([]);
    });

    it("a late red does not arm a later live green", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(late(testRed("a1")));
      clock.now += 5000;
      expect(celebrations.handle(testGreen("a1"))).toEqual([]);
    });

    it("a demo red then a demo green still shimmers", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(demo(testRed("a1")));
      clock.now += 5000;
      expect(celebrations.handle(demo(testGreen("a1")))[0]).toMatchObject({ kind: "shimmer" });
    });
  });
});
