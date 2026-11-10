import { describe, expect, it } from "vitest";
import { createFramePacer, FULL_FPS, IDLE_FPS } from "../../../src/city/runtime/idle-throttle.ts";

// M3.14 roborev 5512 #2: pacing must never draw faster than the target, whatever the display
// refresh rate. The old shouldRenderFrame(targetFps, lastRenderAt, now) let a frame through 0.4 of
// a 60 Hz frame early, so a 90 Hz display (11.1 ms ticks, threshold 10 ms) drew at 90 fps and a
// 144 Hz display at 72 fps.
//
// Interface under test (the implementer creates it in idle-throttle.ts): a small stateful pacer,
//   createFramePacer(): { shouldRender(targetFps: number, now: number): boolean }
// `shouldRender` is called once per display tick with the tick time in ms and the current target
// rate; it returns true when that tick should be drawn and remembers the draw itself.

const REFRESH_RATES = [60, 90, 120, 144] as const;
const TARGETS = [FULL_FPS, IDLE_FPS] as const;

/** Small deterministic jitter in [-1, 1] ms, the size of timer noise on a real display. */
function jitterSource(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return (s / 4294967296) * 2 - 1;
  };
}

function simulate(opts: {
  refreshHz: number;
  targetFps: number;
  seconds: number;
  startAt?: number;
  jitterMs?: number;
  pacer?: ReturnType<typeof createFramePacer>;
}): number {
  const { refreshHz, targetFps, seconds, startAt = 1000, jitterMs = 1 } = opts;
  const pacer = opts.pacer ?? createFramePacer();
  const jitter = jitterSource(refreshHz * 31 + targetFps);
  const tick = 1000 / refreshHz;
  const ticks = Math.round(seconds * refreshHz);
  let drawn = 0;
  for (let i = 0; i < ticks; i++) {
    const now = startAt + i * tick + jitter() * jitterMs * (i === 0 ? 0 : 1);
    if (pacer.shouldRender(targetFps, now)) drawn++;
  }
  return drawn;
}

describe("the frame pacer", () => {
  it("always draws the first tick", () => {
    expect(createFramePacer().shouldRender(IDLE_FPS, 123)).toBe(true);
  });

  describe.each(REFRESH_RATES)("on a %d Hz display", (refreshHz) => {
    it.each(TARGETS)("never sustains more than %d fps", (targetFps) => {
      const seconds = 2;
      const drawn = simulate({ refreshHz, targetFps, seconds });
      // Within about 1 fps over a second.
      expect(drawn / seconds).toBeLessThanOrEqual(targetFps + 1);
    });

    it.each(TARGETS)("is not starved far below %d fps", (targetFps) => {
      const seconds = 2;
      const drawn = simulate({ refreshHz, targetFps, seconds });
      // A display that cannot hit the target exactly (90 Hz at 60 fps) lands on every second
      // tick at best; 70% of the target is the floor for a pacer that works.
      expect(drawn / seconds).toBeGreaterThanOrEqual(targetFps * 0.7);
    });
  });

  it("draws every tick on a 60 Hz display at 60 fps, despite a millisecond of jitter", () => {
    const seconds = 2;
    const drawn = simulate({ refreshHz: 60, targetFps: FULL_FPS, seconds });
    expect(drawn).toBeGreaterThanOrEqual(seconds * 60 - 2);
  });

  it("draws every third tick on a 60 Hz display at 20 fps, despite a millisecond of jitter", () => {
    const seconds = 2;
    const drawn = simulate({ refreshHz: 60, targetFps: IDLE_FPS, seconds });
    expect(drawn).toBeGreaterThanOrEqual(seconds * 20 - 2);
    expect(drawn).toBeLessThanOrEqual(seconds * 20 + 1);
  });

  it("draws at exact multiples without jitter: 120 Hz at 60 fps is every second tick", () => {
    const drawn = simulate({ refreshHz: 120, targetFps: FULL_FPS, seconds: 1, jitterMs: 0 });
    expect(drawn).toBeGreaterThanOrEqual(59);
    expect(drawn).toBeLessThanOrEqual(61);
  });

  it("follows a change of target at once: 20 fps to 60 fps draws the very next 60 Hz tick", () => {
    const pacer = createFramePacer();
    const tick = 1000 / 60;
    expect(pacer.shouldRender(IDLE_FPS, 0)).toBe(true);
    expect(pacer.shouldRender(IDLE_FPS, tick)).toBe(false);
    expect(pacer.shouldRender(FULL_FPS, 2 * tick)).toBe(true);
  });

  it("does not burst to catch up after a long pause such as a hidden tab", () => {
    for (const refreshHz of [60, 144]) {
      for (const targetFps of TARGETS) {
        const pacer = createFramePacer();
        simulate({ refreshHz, targetFps, seconds: 1, pacer });
        // Five seconds with no ticks, then the display runs again.
        const drawn = simulate({
          refreshHz,
          targetFps,
          seconds: 1,
          startAt: 1000 + 1000 + 5000,
          pacer,
        });
        expect(drawn, `${refreshHz} Hz at ${targetFps} fps after a pause`).toBeLessThanOrEqual(
          targetFps + 1,
        );
      }
    }
  });
});

// W1.04 roborev 7895: RenderPacer's idle wake was aimed at last draw + 50 ms, but the pacer
// carries an absolute deadline, so after a late draw the next deadline can be earlier. The pacer
// must expose that deadline: `nextDeadline(): number | null`, null before the first draw.
describe("createFramePacer nextDeadline", () => {
  it("is null before any draw", () => {
    expect(createFramePacer().nextDeadline()).toBeNull();
  });

  it("returns the carried deadline on a 75 Hz display at 20 fps", () => {
    const pacer = createFramePacer();
    const tick = 1000 / 75;
    expect(pacer.shouldRender(IDLE_FPS, 0)).toBe(true);
    expect(pacer.nextDeadline()).toBeCloseTo(50, 9);

    let expected = 50;
    let draws = 0;
    for (let i = 1; i <= 40; i++) {
      const t = i * tick;
      const deadline = pacer.nextDeadline() as number;
      expect(deadline).toBeCloseTo(expected, 6);
      const drew = pacer.shouldRender(IDLE_FPS, t);
      // The first tick at or after the deadline (less the 2 ms tolerance) draws, none earlier.
      expect(drew, `tick ${i} at ${t}`).toBe(t >= deadline - 2);
      if (drew) {
        draws++;
        expected += 50;
      }
    }
    // The deadline is absolute: it advanced by exactly 50 ms per draw, not from the draw time.
    expect(draws).toBeGreaterThan(8);
    expect(pacer.nextDeadline()).toBeCloseTo(expected, 6);
  });
});
