import { describe, expect, it } from "vitest";
import {
  CONFETTI_DURATION_MS,
  CONFETTI_MAX_PARTICLES,
  createCelebrations,
  MIN_BURST_INTERVAL_MS,
} from "../../../src/city/effects/triggers.ts";
import {
  activityEnded,
  gitMerge,
  guessedTestRun,
  handoff,
  taskCompleted,
  taskRunning,
  testGreen,
  testRed,
} from "./events.ts";

function setup(opts: { reducedMotion?: boolean } = {}) {
  const clock = { now: 1_000_000 };
  const celebrations = createCelebrations({
    now: () => clock.now,
    reducedMotion: opts.reducedMotion ?? false,
  });
  return { clock, celebrations };
}

describe("celebration triggers", () => {
  it("states the ARCHITECTURE 2.6 constants", () => {
    expect(MIN_BURST_INTERVAL_MS).toBe(2000);
    expect(CONFETTI_MAX_PARTICLES).toBe(40);
    expect(CONFETTI_DURATION_MS).toBe(1200);
  });

  it("a completed task pops confetti over the agent, within the particle budget", () => {
    const { celebrations } = setup();
    const out = celebrations.handle(taskCompleted("a1"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "confetti", agentId: "a1", durationMs: 1200 });
    expect(out[0]?.kind === "confetti" && out[0].particles).toBeGreaterThan(0);
    expect(out[0]?.kind === "confetti" && out[0].particles).toBeLessThanOrEqual(40);
  });

  it("other task status changes celebrate nothing", () => {
    const { celebrations } = setup();
    expect(celebrations.handle(taskRunning())).toEqual([]);
  });

  it("a handoff is a high-five between the two agents", () => {
    const { celebrations } = setup();
    const out = celebrations.handle(handoff("a1", "a2"));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "high-five", fromAgentId: "a1", toAgentId: "a2" });
  });

  it("an observed merge bursts over Archives", () => {
    const { celebrations } = setup();
    const out = celebrations.handle(gitMerge());
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: "merge-burst", area: "archives" });
  });

  it("ignores events that are not celebrations", () => {
    const { celebrations } = setup();
    expect(celebrations.handle(activityEnded())).toEqual([]);
  });

  describe("rate limit: one burst per 2 s per city", () => {
    it("drops a second burst inside the window, whatever its kind", () => {
      const { celebrations, clock } = setup();
      expect(celebrations.handle(taskCompleted("a1"))).toHaveLength(1);
      clock.now += 1999;
      expect(celebrations.handle(taskCompleted("a2"))).toEqual([]);
      expect(celebrations.handle(handoff())).toEqual([]);
      expect(celebrations.handle(gitMerge())).toEqual([]);
    });

    it("allows the next burst exactly 2 s after the last one that played", () => {
      const { celebrations, clock } = setup();
      expect(celebrations.handle(taskCompleted("a1"))).toHaveLength(1);
      clock.now += 2000;
      expect(celebrations.handle(taskCompleted("a2"))).toHaveLength(1);
    });

    it("a dropped burst does not extend the window", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(taskCompleted("a1")); // plays at t0
      clock.now += 1500;
      expect(celebrations.handle(taskCompleted("a2"))).toEqual([]); // dropped
      clock.now += 500; // t0 + 2000
      expect(celebrations.handle(taskCompleted("a3"))).toHaveLength(1);
    });

    it("is per city: two cities do not share a window", () => {
      const a = setup();
      const b = setup();
      expect(a.celebrations.handle(taskCompleted())).toHaveLength(1);
      expect(b.celebrations.handle(taskCompleted())).toHaveLength(1);
    });
  });

  describe("Test Lab shimmer", () => {
    it("shimmers on a recorded green result after a recorded red", () => {
      const { celebrations, clock } = setup();
      expect(celebrations.handle(testRed("a1"))).toEqual([]);
      clock.now += 5000;
      const out = celebrations.handle(testGreen("a1"));
      expect(out).toHaveLength(1);
      expect(out[0]).toMatchObject({ kind: "shimmer", area: "test-lab" });
    });

    it("does not shimmer on green with no red before it", () => {
      const { celebrations } = setup();
      expect(celebrations.handle(testGreen("a1"))).toEqual([]);
    });

    it("shimmers once per red: a second green in a row is quiet", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(testRed("a1"));
      clock.now += 5000;
      expect(celebrations.handle(testGreen("a1"))).toHaveLength(1);
      clock.now += 5000;
      expect(celebrations.handle(testGreen("a1"))).toEqual([]);
    });

    it("does not shimmer for a red result", () => {
      const { celebrations } = setup();
      celebrations.handle(testGreen("a1"));
      expect(celebrations.handle(testRed("a1"))).toEqual([]);
    });

    it("never shimmers for a guessed (heuristic) test run, even after a recorded red", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(testRed("a1"));
      clock.now += 5000;
      expect(celebrations.handle(guessedTestRun("a1"))).toEqual([]);
      clock.now += 5000;
      expect(celebrations.handle(activityEnded("a1"))).toEqual([]);
    });

    it("a guessed test run neither makes a red nor turns a later green into a shimmer", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(guessedTestRun("a1"));
      clock.now += 5000;
      celebrations.handle(activityEnded("a1"));
      clock.now += 5000;
      // No recorded red exists, so a recorded green is not "green after red".
      expect(celebrations.handle(testGreen("a1"))).toEqual([]);
    });

    it("drops a green that lands inside the rate-limit window instead of queueing it", () => {
      const { celebrations, clock } = setup();
      celebrations.handle(taskCompleted("a2")); // burst at t0
      clock.now += 500;
      celebrations.handle(testRed("a1"));
      clock.now += 500;
      // Green lands inside the window: dropped, not queued.
      expect(celebrations.handle(testGreen("a1"))).toEqual([]);
    });
  });

  describe("reduced motion", () => {
    it("maps every celebration to a sparkle", () => {
      const { celebrations, clock } = setup({ reducedMotion: true });
      const cases = [
        { event: taskCompleted("a1"), source: "confetti" },
        { event: handoff("a1", "a2"), source: "high-five" },
        { event: gitMerge(), source: "merge-burst" },
      ] as const;
      for (const { event, source } of cases) {
        const out = celebrations.handle(event);
        expect(out).toHaveLength(1);
        expect(out[0]).toMatchObject({ kind: "sparkle", source });
        clock.now += 2000;
      }
      celebrations.handle(testRed("a1"));
      clock.now += 2000;
      const shimmer = celebrations.handle(testGreen("a1"));
      expect(shimmer).toHaveLength(1);
      expect(shimmer[0]).toMatchObject({ kind: "sparkle", source: "shimmer" });
    });

    it("emits no confetti, high-five, burst or shimmer while on", () => {
      const { celebrations, clock } = setup({ reducedMotion: true });
      const kinds = new Set<string>();
      for (const event of [taskCompleted(), handoff(), gitMerge(), testRed(), testGreen()]) {
        for (const c of celebrations.handle(event)) kinds.add(c.kind);
        clock.now += 2000;
      }
      expect([...kinds]).toEqual(["sparkle"]);
    });

    it("follows setReducedMotion live", () => {
      const { celebrations, clock } = setup();
      expect(celebrations.handle(taskCompleted())[0]?.kind).toBe("confetti");
      celebrations.setReducedMotion(true);
      clock.now += 2000;
      expect(celebrations.handle(taskCompleted())[0]?.kind).toBe("sparkle");
      celebrations.setReducedMotion(false);
      clock.now += 2000;
      expect(celebrations.handle(taskCompleted())[0]?.kind).toBe("confetti");
    });
  });

  describe("history speed hook", () => {
    it("plays at 1x and 10x", () => {
      const { celebrations, clock } = setup();
      celebrations.setSpeed(1);
      expect(celebrations.handle(taskCompleted())).toHaveLength(1);
      clock.now += 2000;
      celebrations.setSpeed(10);
      expect(celebrations.handle(taskCompleted())).toHaveLength(1);
    });

    it("suppresses everything faster than 10x", () => {
      const { celebrations } = setup();
      for (const speed of [11, 60, 100, 1000]) {
        celebrations.setSpeed(speed);
        expect(celebrations.handle(taskCompleted())).toEqual([]);
        expect(celebrations.handle(handoff())).toEqual([]);
        expect(celebrations.handle(gitMerge())).toEqual([]);
      }
    });

    it("suppression applies in reduced motion too (no sparkle either)", () => {
      const { celebrations } = setup({ reducedMotion: true });
      celebrations.setSpeed(100);
      expect(celebrations.handle(taskCompleted())).toEqual([]);
    });

    it("a suppressed celebration does not use up the rate-limit window", () => {
      const { celebrations } = setup();
      celebrations.setSpeed(100);
      expect(celebrations.handle(taskCompleted())).toEqual([]);
      celebrations.setSpeed(1);
      expect(celebrations.handle(taskCompleted())).toHaveLength(1);
    });

    it("a green after red seen while suppressed is not replayed later", () => {
      const { celebrations, clock } = setup();
      celebrations.setSpeed(100);
      celebrations.handle(testRed("a1"));
      celebrations.handle(testGreen("a1"));
      celebrations.setSpeed(1);
      clock.now += 5000;
      expect(celebrations.handle(testGreen("a1"))).toEqual([]);
    });

    it("defaults to live (1x)", () => {
      const { celebrations } = setup();
      expect(celebrations.handle(taskCompleted())).toHaveLength(1);
    });
  });
});
