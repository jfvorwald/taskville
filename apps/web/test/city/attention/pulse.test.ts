import { describe, expect, it } from "vitest";
import { attentionPulse } from "../../../src/city/attention/pulse.ts";

// Blink safety (ARCHITECTURE.md 2.2): the pulse is a smooth sine, at most 1 Hz, never above 3
// flashes per second. After 10 minutes unhandled it slows but the ring stays. Reduced motion
// turns it into a steady ring. `elapsedMs` is time since the attention record's `since`, taken
// from the same clock the attention selector uses, so replay shows the same pulse as live.

const MIN = 60_000;
const STEP = 5;

type Level = "needs_you" | "trouble" | "waiting";

function intensityAt(level: Level, elapsedMs: number, reducedMotion = false): number {
  return attentionPulse(level, { elapsedMs, reducedMotion }).intensity;
}

function sample(level: Level, fromMs: number, spanMs: number, reducedMotion = false): number[] {
  const out: number[] = [];
  for (let t = fromMs; t <= fromMs + spanMs; t += STEP) {
    out.push(intensityAt(level, t, reducedMotion));
  }
  return out;
}

/** Times (ms) of local maxima of a signal sampled every STEP ms from `fromMs`. */
function peakTimes(values: readonly number[], fromMs: number): number[] {
  const peaks: number[] = [];
  for (let i = 1; i < values.length - 1; i++) {
    const [a, b, c] = [values[i - 1], values[i], values[i + 1]] as [number, number, number];
    if (b > a && b >= c) peaks.push(fromMs + i * STEP);
  }
  return peaks;
}

function gaps(times: readonly number[]): number[] {
  return times.slice(1).map((t, i) => t - (times[i] as number));
}

const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;

describe("attentionPulse: needs you", () => {
  it("is a red ring whose intensity stays within 0..1", () => {
    const first = attentionPulse("needs_you", { elapsedMs: 0, reducedMotion: false });
    expect(first.hue).toBe("red");
    expect(first.ring).toBe(true);
    for (const v of sample("needs_you", 0, 5_000)) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThanOrEqual(1);
    }
  });

  it("pulses about once per second and never faster than 1 Hz", () => {
    const spacing = gaps(peakTimes(sample("needs_you", 0, 30_000), 0));
    expect(spacing.length).toBeGreaterThan(10);
    // Each peak is located to within one sample step, so allow two steps of slack.
    for (const g of spacing) {
      expect(g).toBeGreaterThanOrEqual(1_000 - 2 * STEP);
      expect(g).toBeLessThanOrEqual(1_200);
    }
  });

  it("never reaches 3 flashes within a second over the first 10 minutes", () => {
    let prev = intensityAt("needs_you", 0);
    const risingAt: number[] = [];
    for (let t = STEP; t <= 10 * MIN; t += STEP) {
      const v = intensityAt("needs_you", t);
      if (prev < 0.5 && v >= 0.5) risingAt.push(t);
      prev = v;
    }
    for (let i = 0; i + 2 < risingAt.length; i++) {
      expect((risingAt[i + 2] as number) - (risingAt[i] as number)).toBeGreaterThan(1_000);
    }
    // And it really is about one flash per second, not zero.
    expect(risingAt.length).toBeGreaterThan(500);
  });

  it("is smooth: no step in intensity between samples, including across the 10 minute slowdown", () => {
    // A sine of amplitude 0.5 at 1 Hz moves at most about pi/2 per second, so 5 ms moves 0.008.
    const windows: [number, number][] = [
      [0, 3_000],
      [10 * MIN - 3_000, 6_000],
      [14 * MIN, 5_000],
    ];
    for (const [from, span] of windows) {
      const values = sample("needs_you", from, span);
      for (let i = 1; i < values.length; i++) {
        expect(Math.abs((values[i] as number) - (values[i - 1] as number))).toBeLessThan(0.02);
      }
    }
  });

  it("slows after 10 minutes unhandled and keeps the ring", () => {
    const before = gaps(peakTimes(sample("needs_you", 2 * MIN, 30_000), 2 * MIN));
    const after = gaps(peakTimes(sample("needs_you", 11 * MIN, 30_000), 11 * MIN));
    expect(after.length).toBeGreaterThan(3);
    expect(mean(after)).toBeGreaterThanOrEqual(mean(before) * 1.5);

    const late = attentionPulse("needs_you", { elapsedMs: 14 * MIN, reducedMotion: false });
    expect(late.ring).toBe(true);
    expect(late.hue).toBe("red");
    expect(late.frequencyHz).toBeGreaterThan(0);
    expect(late.frequencyHz).toBeLessThan(
      attentionPulse("needs_you", { elapsedMs: 2 * MIN, reducedMotion: false }).frequencyHz,
    );
    // Still pulsing, so it is not a steady ring.
    const lateValues = sample("needs_you", 14 * MIN, 10_000);
    expect(Math.max(...lateValues) - Math.min(...lateValues)).toBeGreaterThan(0.3);
  });

  it("reports a frequency in (0, 1] Hz at every sampled time over 15 minutes", () => {
    for (let t = 0; t <= 15 * MIN; t += 1_000) {
      const { frequencyHz } = attentionPulse("needs_you", { elapsedMs: t, reducedMotion: false });
      expect(frequencyHz).toBeLessThanOrEqual(1);
      expect(frequencyHz).toBeGreaterThan(0);
    }
  });
});

describe("attentionPulse: trouble", () => {
  it("is an amber ring that pulses slower than needs-you", () => {
    const first = attentionPulse("trouble", { elapsedMs: 0, reducedMotion: false });
    expect(first.hue).toBe("amber");
    expect(first.ring).toBe(true);
    const troubleGaps = gaps(peakTimes(sample("trouble", 0, 30_000), 0));
    const needsGaps = gaps(peakTimes(sample("needs_you", 0, 30_000), 0));
    expect(troubleGaps.length).toBeGreaterThan(3);
    expect(mean(troubleGaps)).toBeGreaterThanOrEqual(mean(needsGaps) * 2);
    expect(first.frequencyHz).toBeLessThanOrEqual(0.5);
    expect(first.frequencyHz).toBeGreaterThan(0);
  });
});

describe("attentionPulse: waiting", () => {
  it("has no hue, no ring and no pulse", () => {
    const state = attentionPulse("waiting", { elapsedMs: 5_000, reducedMotion: false });
    expect(state.hue).toBeNull();
    expect(state.ring).toBe(false);
    expect(state.frequencyHz).toBe(0);
    expect(new Set(sample("waiting", 0, 5_000)).size).toBe(1);
  });
});

describe("attentionPulse: reduced motion", () => {
  it("makes needs-you a steady red ring that does not oscillate", () => {
    const values = [
      ...sample("needs_you", 0, 5_000, true),
      ...sample("needs_you", 11 * MIN, 5_000, true),
    ];
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBeGreaterThan(0);
    const state = attentionPulse("needs_you", { elapsedMs: 1_234, reducedMotion: true });
    expect(state.ring).toBe(true);
    expect(state.hue).toBe("red");
    expect(state.frequencyHz).toBe(0);
  });

  it("makes trouble a steady amber ring", () => {
    const values = sample("trouble", 0, 8_000, true);
    expect(new Set(values).size).toBe(1);
    expect(values[0]).toBeGreaterThan(0);
    const state = attentionPulse("trouble", { elapsedMs: 777, reducedMotion: true });
    expect(state.ring).toBe(true);
    expect(state.hue).toBe("amber");
    expect(state.frequencyHz).toBe(0);
  });

  it("leaves waiting as it was", () => {
    const state = attentionPulse("waiting", { elapsedMs: 100, reducedMotion: true });
    expect(state.hue).toBeNull();
    expect(state.ring).toBe(false);
  });
});

describe("attentionPulse: determinism", () => {
  it("depends only on its inputs", () => {
    const a = attentionPulse("needs_you", { elapsedMs: 4_321, reducedMotion: false });
    const b = attentionPulse("needs_you", { elapsedMs: 4_321, reducedMotion: false });
    expect(a).toEqual(b);
  });

  it("treats a negative elapsed time (clock skew) as zero", () => {
    expect(intensityAt("needs_you", -500)).toBe(intensityAt("needs_you", 0));
  });
});
