import { describe, expect, it } from "vitest";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import { aeroTheme } from "../../../src/themes/aero/index.ts";
import {
  CITY_PALETTE_KEYS,
  cityPaletteFromTokens,
  resolveTokens,
  validateAccents,
  validateTheme,
} from "../../../src/themes/core/contract.ts";

const lum = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
};

describe("aero theme", () => {
  it("satisfies the theme contract", () => {
    expect(aeroTheme.id).toBe("aero");
    expect(validateTheme(aeroTheme)).toEqual([]);
    expect(validateAccents(CITY_LAYOUT, aeroTheme.accents)).toEqual([]);
  });

  it("is a bright, glassy blue day theme with a darker night", () => {
    const day = resolveTokens(aeroTheme, "day");
    const night = resolveTokens(aeroTheme, "night");
    expect(lum(day["--tv-scene-bg"])).toBeGreaterThan(600);
    expect(lum(night["--tv-scene-bg"])).toBeLessThan(lum(day["--tv-scene-bg"]));
    // Blue-led: the plaza is the water, blue channel dominates.
    const plaza = Number.parseInt(day["--tv-city-plaza"].slice(1), 16);
    expect(plaza & 255).toBeGreaterThan((plaza >> 16) & 255);
  });

  it("gives every palette entry a hex color", () => {
    const palette = cityPaletteFromTokens(resolveTokens(aeroTheme, "night"));
    for (const key of CITY_PALETTE_KEYS) expect(palette[key]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("adds glass panels to every building and has a soft history tint", () => {
    for (const area of CITY_LAYOUT.areas) {
      const own = aeroTheme.accents.filter((a) => a.areas === "all" || a.areas.includes(area.id));
      expect(own.length).toBeGreaterThan(0);
    }
    expect(aeroTheme.history.desaturate).toBeGreaterThan(0);
    expect(aeroTheme.history.desaturate).toBeLessThan(0.5);
  });
});
