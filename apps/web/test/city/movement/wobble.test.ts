import { describe, expect, it } from "vitest";
import { wobbleOffset } from "../../../src/city/movement/wobble.ts";

// The tipsy sway on the walk back from the bar: a sideways offset (meters) that is a pure
// function of how far along the walk the agent is (0 at the bar, 1 at the workstation).

describe("wobbleOffset", () => {
  it("is zero at the start and the end of the walk, so it never jumps", () => {
    expect(wobbleOffset(0, false)).toBeCloseTo(0, 9);
    expect(wobbleOffset(1, false)).toBeCloseTo(0, 9);
  });

  it("sways in between, by a small amount", () => {
    const samples = Array.from({ length: 49 }, (_, i) => wobbleOffset((i + 1) / 50, false));
    expect(samples.some((v) => Math.abs(v) > 0.02)).toBe(true);
    for (const v of samples) expect(Math.abs(v)).toBeLessThanOrEqual(0.3);
  });

  it("is zero everywhere under reduced motion", () => {
    for (let i = 0; i <= 20; i++) expect(wobbleOffset(i / 20, true)).toBe(0);
  });

  it("is a pure function of progress", () => {
    expect(wobbleOffset(0.37, false)).toBe(wobbleOffset(0.37, false));
  });
});
