import { describe, expect, it } from "vitest";
import {
  computeLighting,
  localMinutes,
  PHASE_BOUNDS,
  phaseAt,
} from "../../../src/city/lighting/phase.ts";

/** An instant for a given UTC wall time. */
const utc = (iso: string) => Date.parse(`${iso}Z`);

describe("localMinutes", () => {
  it("reads the minute of the local day in the given IANA zone", () => {
    const t = utc("2026-10-31T12:00:00");
    expect(localMinutes(t, "UTC")).toBe(12 * 60);
    expect(localMinutes(t, "Asia/Tokyo")).toBe(21 * 60);
    expect(localMinutes(t, "America/Los_Angeles")).toBe(5 * 60);
    expect(localMinutes(t, "Asia/Kolkata")).toBe(17 * 60 + 30);
  });

  it("follows daylight saving time", () => {
    // New York is UTC-4 before 2026-11-01 and UTC-5 after it.
    expect(localMinutes(utc("2026-10-31T16:00:00"), "America/New_York")).toBe(12 * 60);
    expect(localMinutes(utc("2026-11-01T17:00:00"), "America/New_York")).toBe(12 * 60);
  });

  it("falls back to UTC for an unknown zone", () => {
    expect(localMinutes(utc("2026-10-31T03:30:00"), "Not/AZone")).toBe(3 * 60 + 30);
  });
});

describe("phaseAt boundaries", () => {
  const at = (h: number, m = 0) => phaseAt(h * 60 + m);
  it("is night before dawn starts and after dusk ends", () => {
    expect(at(0)).toBe("night");
    expect(at(5, 29)).toBe("night");
    expect(at(19, 30)).toBe("night");
    expect(at(23, 59)).toBe("night");
  });
  it("is dawn from its start up to day", () => {
    expect(PHASE_BOUNDS.dawnStart).toBe(5 * 60 + 30);
    expect(at(5, 30)).toBe("dawn");
    expect(at(7, 29)).toBe("dawn");
  });
  it("is day from its start up to dusk", () => {
    expect(at(7, 30)).toBe("day");
    expect(at(12)).toBe("day");
    expect(at(17, 29)).toBe("day");
  });
  it("is dusk from its start up to night", () => {
    expect(at(17, 30)).toBe("dusk");
    expect(at(19, 29)).toBe("dusk");
  });
});

describe("computeLighting", () => {
  it("is full day at noon: sun high, no lamps, day mode", () => {
    const s = computeLighting(12 * 60);
    expect(s.phase).toBe("day");
    expect(s.nightness).toBe(0);
    expect(s.mode).toBe("day");
    expect(s.sunElevationDeg).toBeGreaterThan(60);
  });

  it("is full night at 2 a.m.: sun below the horizon, lamps on, night mode", () => {
    const s = computeLighting(2 * 60);
    expect(s.phase).toBe("night");
    expect(s.nightness).toBe(1);
    expect(s.mode).toBe("night");
    expect(s.sunElevationDeg).toBeLessThan(0);
  });

  it("dusk ramps nightness from 0 to 1 and flips to night mode (lamps and windows on) halfway", () => {
    const start = computeLighting(17 * 60 + 30);
    const early = computeLighting(18 * 60);
    const late = computeLighting(19 * 60);
    const end = computeLighting(19 * 60 + 30);
    expect(start.nightness).toBe(0);
    expect(end.nightness).toBe(1);
    expect(early.nightness).toBeGreaterThan(0);
    expect(late.nightness).toBeGreaterThan(early.nightness);
    expect(early.mode).toBe("day");
    expect(late.mode).toBe("night");
    expect(computeLighting(18 * 60 + 30).mode).toBe("night");
  });

  it("dawn ramps nightness from 1 to 0 and turns the lamps off", () => {
    expect(computeLighting(5 * 60 + 30).nightness).toBe(1);
    expect(computeLighting(7 * 60 + 30).nightness).toBe(0);
    expect(computeLighting(6 * 60).mode).toBe("night");
    expect(computeLighting(7 * 60).mode).toBe("day");
  });

  it("keeps ambient and sun intensity lower at night than by day", () => {
    const day = computeLighting(12 * 60);
    const night = computeLighting(2 * 60);
    expect(night.ambientIntensity).toBeLessThan(day.ambientIntensity);
    expect(night.sunIntensity).toBeLessThan(day.sunIntensity);
    expect(night.ambientIntensity).toBeGreaterThan(0);
  });

  it("is continuous across midnight", () => {
    const a = computeLighting(24 * 60 - 1);
    const b = computeLighting(0);
    expect(Math.abs(a.sunElevationDeg - b.sunElevationDeg)).toBeLessThan(1);
  });
});
