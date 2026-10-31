import { describe, expect, it } from "vitest";
import { celebrationsAtSpeed } from "../../../src/city/effects/speed.ts";

// ARCHITECTURE 2.6: replay plays celebrations at 1x and 10x and suppresses them at faster speeds.
describe("celebrationsAtSpeed", () => {
  it.each([0.5, 1, 2, 5, 10])("plays at %sx", (speed) => {
    expect(celebrationsAtSpeed(speed)).toBe("play");
  });

  it.each([10.5, 11, 30, 60, 100, 1000])("suppresses at %sx", (speed) => {
    expect(celebrationsAtSpeed(speed)).toBe("suppress");
  });
});
