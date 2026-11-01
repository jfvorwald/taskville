import { describe, expect, it } from "vitest";
import { formatWaiting } from "../../../src/overlays/action-card/format.ts";

// M4.07: "how long" on the card. `formatWaiting(ms)` takes the elapsed milliseconds
// (store clock minus the attention record's `since`) and returns a short whole-second label.

describe("formatWaiting", () => {
  it.each([
    [0, "0s"],
    [999, "0s"],
    [45_000, "45s"],
    [59_999, "59s"],
    [60_000, "1m 0s"],
    [125_000, "2m 5s"],
    [3_599_000, "59m 59s"],
    [3_600_000, "1h 0m"],
    [3_725_000, "1h 2m"],
    [90_000_000, "25h 0m"],
  ])("%i ms is %s", (ms, label) => {
    expect(formatWaiting(ms)).toBe(label);
  });

  it("never shows a negative or non-finite wait (clock skew, bad timestamp)", () => {
    expect(formatWaiting(-5_000)).toBe("0s");
    expect(formatWaiting(Number.NaN)).toBe("0s");
    expect(formatWaiting(Number.POSITIVE_INFINITY)).toBe("0s");
  });
});
