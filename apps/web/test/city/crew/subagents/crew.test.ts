import { describe, expect, it } from "vitest";
import {
  CREW_INDIVIDUAL_LIMIT,
  collapseCrew,
  crewMarkerLabel,
  FAN_OUT_MS,
} from "../../../../src/city/crew/subagents/crew.ts";

const ids = (n: number): string[] => Array.from({ length: n }, (_, i) => `s${i + 1}`);

describe("collapseCrew", () => {
  it("gives up to three subagents their own bot and no marker", () => {
    expect(CREW_INDIVIDUAL_LIMIT).toBe(3);
    for (const n of [0, 1, 2, 3]) {
      const view = collapseCrew(ids(n), { nowMs: 0 });
      expect(view.individual).toEqual(ids(n));
      expect(view.marker).toBeUndefined();
    }
  });

  it("puts the first three in order and the rest behind one marker beyond three", () => {
    const view = collapseCrew(ids(4), { nowMs: 0 });
    expect(view.individual).toEqual(["s1", "s2", "s3"]);
    expect(view.marker).toEqual({ count: 1, hiddenIds: ["s4"] });

    const many = collapseCrew(ids(9), { nowMs: 0 });
    expect(many.individual).toEqual(["s1", "s2", "s3"]);
    expect(many.marker?.count).toBe(6);
    expect(many.marker?.hiddenIds).toEqual(["s4", "s5", "s6", "s7", "s8", "s9"]);
  });

  it("fans every bot out for a short time after a click on the marker", () => {
    const view = collapseCrew(ids(6), { fannedAtMs: 1000, nowMs: 1000 + FAN_OUT_MS - 1 });
    expect(view.individual).toEqual(ids(6));
    expect(view.marker).toBeUndefined();
  });

  it("collapses again once the fan-out time has passed", () => {
    expect(FAN_OUT_MS).toBeGreaterThan(0);
    const view = collapseCrew(ids(6), { fannedAtMs: 1000, nowMs: 1000 + FAN_OUT_MS });
    expect(view.individual).toEqual(["s1", "s2", "s3"]);
    expect(view.marker?.count).toBe(3);
  });

  it("does not fan out before the click happened (injected clock behind it)", () => {
    const view = collapseCrew(ids(5), { fannedAtMs: 5000, nowMs: 4000 });
    expect(view.marker?.count).toBe(2);
  });
});

describe("crewMarkerLabel", () => {
  it("reads +N crew", () => {
    expect(crewMarkerLabel(2)).toBe("+2 crew");
    expect(crewMarkerLabel(11)).toBe("+11 crew");
  });
});
