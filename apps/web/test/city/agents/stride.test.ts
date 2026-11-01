import { describe, expect, it } from "vitest";
import { advanceStride } from "../../../src/city/agents/stride.ts";

// The walk cycle must run at a rate set by time, not by how many frames a display draws. The old
// code added 0.25 radians per frame, which is 15 rad/s at 60 Hz and 30 rad/s at 120 Hz.

function run(hz: number, seconds: number, start = 0): number {
  let stride = start;
  const dt = 1 / hz;
  for (let i = 0; i < Math.round(hz * seconds); i++) stride = advanceStride(stride, dt);
  return stride;
}

describe("advanceStride", () => {
  it("advances the same amount per second at 60 Hz and 120 Hz", () => {
    expect(run(120, 1)).toBeCloseTo(run(60, 1), 6);
    expect(run(144, 2)).toBeCloseTo(run(30, 2), 6);
  });

  it("matches the previous rate at 60 Hz: 0.25 per frame, 15 radians per second", () => {
    expect(advanceStride(0, 1 / 60)).toBeCloseTo(0.25, 6);
    expect(run(60, 1)).toBeCloseTo(15, 6);
  });

  it("adds to the current stride and does nothing for a zero step", () => {
    expect(advanceStride(2, 0)).toBe(2);
    expect(advanceStride(2, 1 / 60)).toBeCloseTo(2.25, 6);
  });
});
