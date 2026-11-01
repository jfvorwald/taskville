import { describe, expect, it } from "vitest";
import {
  createIdleThrottle,
  FULL_FPS,
  IDLE_FPS,
  type MotionSignals,
  shouldRenderFrame,
} from "../../../src/city/runtime/idle-throttle.ts";

// M3.14, ARCHITECTURE.md section 11: "frame rate drops to 20 fps when nothing is moving". The
// throttle is pure: motion signals and a clock go in, a target frame rate comes out.

const still: MotionSignals = { agentsMoving: false, cameraMoving: false, effectsActive: false };

function setup(idleAfterMs = 1000) {
  let t = 0;
  const throttle = createIdleThrottle({ now: () => t, idleAfterMs });
  return {
    throttle,
    at(ms: number) {
      t = ms;
    },
  };
}

describe("the idle throttle", () => {
  it("uses the documented rates: 60 fps full, 20 fps idle", () => {
    expect(FULL_FPS).toBe(60);
    expect(IDLE_FPS).toBe(20);
  });

  it("starts at the full rate and drops to 20 fps once nothing has moved for the idle delay", () => {
    const { throttle, at } = setup(1000);
    at(0);
    expect(throttle.update(still)).toBe(FULL_FPS);
    at(999);
    expect(throttle.update(still)).toBe(FULL_FPS);
    at(1000);
    expect(throttle.update(still)).toBe(IDLE_FPS);
    at(60_000);
    expect(throttle.update(still)).toBe(IDLE_FPS);
  });

  it.each([
    ["an agent walking", { ...still, agentsMoving: true }],
    ["the camera moving", { ...still, cameraMoving: true }],
    ["an effect playing", { ...still, effectsActive: true }],
  ] as const)("returns to the full rate at once when %s", (_name, moving) => {
    const { throttle, at } = setup(1000);
    at(5000);
    expect(throttle.update(still)).toBe(IDLE_FPS);
    at(5016);
    expect(throttle.update(moving)).toBe(FULL_FPS);
    at(5500);
    expect(throttle.update(moving)).toBe(FULL_FPS);
  });

  it("waits the full idle delay after the last movement before dropping again", () => {
    const { throttle, at } = setup(1000);
    at(5000);
    throttle.update({ ...still, agentsMoving: true });
    at(5600);
    expect(throttle.update(still)).toBe(FULL_FPS);
    at(6599);
    expect(throttle.update(still)).toBe(FULL_FPS);
    at(6600);
    expect(throttle.update(still)).toBe(IDLE_FPS);
  });
});

describe("frame pacing against a 60 Hz display", () => {
  const TICK = 1000 / 60;

  function rendersInOneSecond(targetFps: number): number {
    let last: number | null = null;
    let count = 0;
    for (let i = 0; i < 60; i++) {
      const now = i * TICK;
      if (shouldRenderFrame(targetFps, last, now)) {
        last = now;
        count++;
      }
    }
    return count;
  }

  it("always draws the first frame", () => {
    expect(shouldRenderFrame(IDLE_FPS, null, 123)).toBe(true);
  });

  it("draws every display frame at the full rate", () => {
    expect(rendersInOneSecond(FULL_FPS)).toBeGreaterThanOrEqual(59);
  });

  it("draws about one display frame in three at 20 fps", () => {
    const drawn = rendersInOneSecond(IDLE_FPS);
    expect(drawn).toBeGreaterThanOrEqual(17);
    expect(drawn).toBeLessThanOrEqual(21);
  });

  it("skips a display frame that arrives well before the next 20 fps slot", () => {
    expect(shouldRenderFrame(IDLE_FPS, 0, TICK)).toBe(false);
    expect(shouldRenderFrame(IDLE_FPS, 0, 2 * TICK)).toBe(false);
    expect(shouldRenderFrame(IDLE_FPS, 0, 3 * TICK + 1)).toBe(true);
  });
});
