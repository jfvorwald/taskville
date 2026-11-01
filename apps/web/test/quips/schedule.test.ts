import { describe, expect, it, vi } from "vitest";
import { QUIP_VISIBLE_MS, quipSchedule, quipVisibleAt } from "../../src/quips/schedule.ts";

// M4.06: when a bubble shows. The first one appears when the state starts, then it repeats every
// 45 to 90 s while the state lasts, each visible about 4 s. The jitter is seeded from the agent
// and event IDs, and time is passed in, so a replay matches live (ARCHITECTURE.md 2.3 and 3).
// Times are milliseconds on the same clock as the attention record's `sinceMs`.

const input = { agentId: "agent-1", eventId: "evt-1", sinceMs: 1_000_000 };

describe("quipSchedule", () => {
  it("shows the first bubble at the state start for about 4 s", () => {
    expect(QUIP_VISIBLE_MS).toBe(4000);
    const [first] = quipSchedule({ ...input, count: 3 });
    expect(first).toEqual({ startMs: input.sinceMs, endMs: input.sinceMs + QUIP_VISIBLE_MS });
  });

  it("returns exactly `count` windows", () => {
    expect(quipSchedule({ ...input, count: 0 })).toEqual([]);
    expect(quipSchedule({ ...input, count: 7 })).toHaveLength(7);
  });

  it("repeats with a gap between starts in [45 s, 90 s]", () => {
    for (let i = 0; i < 50; i++) {
      const windows = quipSchedule({
        agentId: `agent-${i}`,
        eventId: `evt-${i}`,
        sinceMs: 0,
        count: 12,
      });
      for (let w = 1; w < windows.length; w++) {
        const gap = windows[w].startMs - windows[w - 1].startMs;
        expect(gap).toBeGreaterThanOrEqual(45_000);
        expect(gap).toBeLessThanOrEqual(90_000);
        expect(windows[w].endMs - windows[w].startMs).toBe(QUIP_VISIBLE_MS);
      }
    }
  });

  it("is identical for identical inputs", () => {
    expect(quipSchedule({ ...input, count: 10 })).toEqual(quipSchedule({ ...input, count: 10 }));
  });

  it("is stable when more windows are asked for", () => {
    const few = quipSchedule({ ...input, count: 3 });
    const many = quipSchedule({ ...input, count: 10 });
    expect(many.slice(0, 3)).toEqual(few);
  });

  it("is identical after the module is reloaded", async () => {
    const before = quipSchedule({ ...input, count: 6 });
    vi.resetModules();
    const reloaded = await import("../../src/quips/schedule.ts");
    expect(reloaded.quipSchedule({ ...input, count: 6 })).toEqual(before);
  });

  it("jitters differently for different events", () => {
    const firstGaps = new Set(
      Array.from({ length: 40 }, (_, i) => {
        const [a, b] = quipSchedule({
          agentId: "agent-1",
          eventId: `evt-${i}`,
          sinceMs: 0,
          count: 2,
        });
        return b.startMs - a.startMs;
      }),
    );
    expect(firstGaps.size).toBeGreaterThan(5);
  });

  it("shifts uniformly with the start time", () => {
    const base = quipSchedule({ ...input, sinceMs: 0, count: 6 });
    const shifted = quipSchedule({ ...input, sinceMs: 123_456, count: 6 });
    expect(shifted).toEqual(
      base.map((w) => ({ startMs: w.startMs + 123_456, endMs: w.endMs + 123_456 })),
    );
  });

  it("reads no clock and no random source", () => {
    const now = vi.spyOn(Date, "now");
    const perf = vi.spyOn(performance, "now");
    const random = vi.spyOn(Math, "random");
    quipSchedule({ ...input, count: 5 });
    quipVisibleAt(input, input.sinceMs + 10);
    expect(now).not.toHaveBeenCalled();
    expect(perf).not.toHaveBeenCalled();
    expect(random).not.toHaveBeenCalled();
    now.mockRestore();
    perf.mockRestore();
    random.mockRestore();
  });
});

// roborev 5873 #3 and code review: the overlay asks every 500 ms, so the answer must cost bounded
// work however old the state is. CTO decision: quips stop after 24 h unhandled (the red ring
// stays), so a state older than that shows no bubble. Within 24 h the answer is the unbounded
// definition: the seeded run of gaps from `quipSchedule`.
describe("quipVisibleAt bounded cost", () => {
  const HOUR = 3_600_000;
  const NOW = Date.parse("2026-11-01T10:00:00.000Z");

  it("answers a months-old state quickly (no scan from the start of time)", () => {
    // Warm the code path with another key so JIT and module setup are not counted.
    quipVisibleAt({ agentId: "warm", eventId: "warm", sinceMs: NOW - HOUR }, NOW);
    const t0 = performance.now();
    for (let i = 0; i < 5; i++) {
      quipVisibleAt({ agentId: `agent-${i}`, eventId: `old-${i}`, sinceMs: 0 }, NOW);
    }
    const perCall = (performance.now() - t0) / 5;
    // Unbounded, since 0 is ~26 million gap draws per call (hundreds of ms).
    expect(perCall).toBeLessThan(5);
  });

  it("shows no bubble for a state more than 24 h old, whatever the seed", () => {
    const sinceMs = NOW - 25 * HOUR;
    const shown: string[] = [];
    for (let i = 0; i < 300; i++) {
      const key = { agentId: `agent-${i}`, eventId: `evt-${i}`, sinceMs };
      if (quipVisibleAt(key, NOW)) shown.push(key.agentId);
    }
    expect(shown).toEqual([]);
    expect(quipVisibleAt({ agentId: "a", eventId: "e", sinceMs: 0 }, NOW)).toBe(false);
  });

  it("matches the unbounded schedule for a state under 24 h old", () => {
    for (let i = 0; i < 20; i++) {
      const key = { agentId: `agent-${i}`, eventId: `evt-${i}`, sinceMs: NOW };
      // The shortest gap is 45 s, so 1000 windows span at least 12.5 h and at most 25 h.
      const windows = quipSchedule({ ...key, count: 1000 });
      // Probe only windows that start well inside the first 23 h of the state.
      const inRange = windows.filter((w) => w.endMs - NOW < 23 * HOUR);
      expect(inRange.length).toBeGreaterThan(500);
      for (const w of [
        inRange[0],
        inRange[1],
        inRange[7],
        inRange[100],
        inRange[inRange.length - 1],
      ]) {
        const win = w as { startMs: number; endMs: number };
        expect(quipVisibleAt(key, win.startMs)).toBe(true);
        expect(quipVisibleAt(key, win.endMs - 1)).toBe(true);
        expect(quipVisibleAt(key, win.endMs)).toBe(false);
        expect(quipVisibleAt(key, win.startMs - 1)).toBe(false);
      }
    }
  });
});

describe("quipVisibleAt", () => {
  const windows = quipSchedule({ ...input, count: 4 });

  it("is visible from the start until 4 s later, then hidden", () => {
    expect(quipVisibleAt(input, input.sinceMs)).toBe(true);
    expect(quipVisibleAt(input, input.sinceMs + QUIP_VISIBLE_MS - 1)).toBe(true);
    expect(quipVisibleAt(input, input.sinceMs + QUIP_VISIBLE_MS)).toBe(false);
  });

  it("is hidden before the state starts", () => {
    expect(quipVisibleAt(input, input.sinceMs - 1)).toBe(false);
  });

  it("is hidden between repeats and visible again at each repeat", () => {
    const second = windows[1];
    expect(quipVisibleAt(input, second.startMs - 1)).toBe(false);
    expect(quipVisibleAt(input, second.startMs)).toBe(true);
    expect(quipVisibleAt(input, second.endMs)).toBe(false);
    const fourth = windows[3];
    expect(quipVisibleAt(input, fourth.startMs + 1)).toBe(true);
  });
});
