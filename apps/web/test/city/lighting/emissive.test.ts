import { describe, expect, it } from "vitest";
import { createLightingController } from "../../../src/city/lighting/controller.ts";
import { emissiveLevel } from "../../../src/city/lighting/emissive.ts";
import { createThemeController } from "../../../src/themes/core/index.ts";
import { cyberpunkTheme } from "../../../src/themes/cyberpunk/index.ts";

// Asia/Tokyo has no daylight saving, so local time is always UTC+9.
const ZONE = "Asia/Tokyo";
const tokyo = (hhmm: string) => Date.parse(`2026-10-31T${hhmm}:00+09:00`);

function setup() {
  const theme = createThemeController({ themes: [cyberpunkTheme] });
  const lighting = createLightingController({
    theme,
    now: () => tokyo("12:00"),
    timeZone: ZONE,
  });
  return lighting;
}

/** The shared emissive level the city would use at a local time, via the controller. */
function levelAt(hhmm: string): number {
  const lighting = setup();
  lighting.setTime(tokyo(hhmm));
  return emissiveLevel(lighting.state().nightness);
}

describe("emissiveLevel", () => {
  it("is dim at noon: at most a quarter of the night level", () => {
    expect(emissiveLevel(0)).toBeLessThanOrEqual(0.25);
    expect(emissiveLevel(0)).toBeLessThanOrEqual(0.25 * emissiveLevel(1));
  });

  it("is full (1) at night", () => {
    expect(emissiveLevel(1)).toBe(1);
  });

  it("never leaves the 0..1 range, and clamps out-of-range nightness", () => {
    for (let i = 0; i <= 20; i += 1) {
      const level = emissiveLevel(i / 20);
      expect(level).toBeGreaterThanOrEqual(0);
      expect(level).toBeLessThanOrEqual(1);
    }
    expect(emissiveLevel(-1)).toBe(emissiveLevel(0));
    expect(emissiveLevel(2)).toBe(emissiveLevel(1));
  });

  it("is monotonic non-decreasing over nightness 0..1 (21 samples) and actually rises", () => {
    const levels = Array.from({ length: 21 }, (_, i) => emissiveLevel(i / 20));
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i], `sample ${i}`).toBeGreaterThanOrEqual(levels[i - 1] as number);
    }
    expect(levels[20]).toBeGreaterThan((levels[0] as number) + 0.5);
  });
});

describe("emissiveLevel driven by an injected time", () => {
  it("rises from local noon through dusk (18:30) to night (23:00)", () => {
    const noon = levelAt("12:00");
    const dusk = levelAt("18:30");
    const night = levelAt("23:00");
    expect(noon).toBeLessThanOrEqual(0.25);
    expect(dusk).toBeGreaterThan(noon);
    expect(night).toBeGreaterThan(dusk);
    expect(night).toBe(1);
  });

  it("ramps monotonically through dusk, sampled every 10 minutes from 17:30 to 19:30", () => {
    const lighting = setup();
    const levels: number[] = [];
    for (let m = 17 * 60 + 30; m <= 19 * 60 + 30; m += 10) {
      const hh = String(Math.floor(m / 60)).padStart(2, "0");
      const mm = String(m % 60).padStart(2, "0");
      lighting.setTime(tokyo(`${hh}:${mm}`));
      levels.push(emissiveLevel(lighting.state().nightness));
    }
    for (let i = 1; i < levels.length; i += 1) {
      expect(levels[i], `step ${i}`).toBeGreaterThanOrEqual(levels[i - 1] as number);
    }
    expect(levels[levels.length - 1]).toBeGreaterThan(levels[0] as number);
  });

  it("follows the injected time, not the clock, and falls again after dawn", () => {
    const lighting = setup();
    lighting.setTime(tokyo("23:00"));
    const night = emissiveLevel(lighting.state().nightness);
    lighting.setTime(tokyo("12:00"));
    const noon = emissiveLevel(lighting.state().nightness);
    expect(noon).toBeLessThan(night);
    lighting.setTime(null); // back to the clock, which is noon
    expect(emissiveLevel(lighting.state().nightness)).toBe(noon);
  });

  it("always-night holds the full level and always-day the dim one", () => {
    const lighting = setup();
    lighting.setSetting("always-night");
    expect(emissiveLevel(lighting.state().nightness)).toBe(1);
    lighting.setSetting("always-day");
    expect(emissiveLevel(lighting.state().nightness)).toBeLessThanOrEqual(0.25);
  });
});
