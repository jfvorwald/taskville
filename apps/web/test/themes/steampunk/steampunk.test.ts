import { describe, expect, it } from "vitest";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import {
  CITY_PALETTE_KEYS,
  cityPaletteFromTokens,
  resolveTokens,
  validateAccents,
  validateTheme,
} from "../../../src/themes/core/index.ts";
import { THEMES } from "../../../src/themes/core/themes.ts";
import { steampunkTheme } from "../../../src/themes/steampunk/index.ts";

const lum = (hex: string) => {
  const n = Number.parseInt(hex.slice(1), 16);
  return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
};

describe("steampunk theme", () => {
  it("meets the theme contract", () => {
    expect(steampunkTheme.id).toBe("steampunk");
    expect(validateTheme(steampunkTheme)).toEqual([]);
    expect(validateAccents(CITY_LAYOUT, steampunkTheme.accents)).toEqual([]);
  });

  it("is registered", () => {
    expect(THEMES.map((t) => t.id)).toContain("steampunk");
  });

  it("is a warm, light parchment city with a darker night", () => {
    const day = resolveTokens(steampunkTheme, "day");
    const night = resolveTokens(steampunkTheme, "night");
    expect(lum(day["--tv-scene-bg"])).toBeGreaterThan(600);
    expect(lum(night["--tv-scene-bg"])).toBeLessThan(lum(day["--tv-scene-bg"]));
    // warm: red channel above blue for walls and ground
    for (const key of ["--tv-city-wall", "--tv-city-ground"] as const) {
      const n = Number.parseInt(day[key].slice(1), 16);
      expect((n >> 16) & 255).toBeGreaterThan(n & 255);
    }
  });

  it("gives every palette entry a hex color", () => {
    const palette = cityPaletteFromTokens(resolveTokens(steampunkTheme, "night"));
    for (const key of CITY_PALETTE_KEYS) expect(palette[key]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("puts a clock tower on the tallest building and a chimney on the workshop", () => {
    const tallest = [...CITY_LAYOUT.areas].sort((a, b) => b.height - a.height)[0];
    const tower = steampunkTheme.accents.filter((a) => a.id.includes("clock"));
    expect(tower.length).toBeGreaterThan(0);
    for (const a of tower) expect(a.areas).toEqual([tallest?.id]);
    const chimney = steampunkTheme.accents.filter((a) => a.id.includes("chimney"));
    expect(chimney.length).toBeGreaterThan(0);
    for (const a of chimney) expect(a.areas).toEqual(["workshop"]);
  });

  it("has a sepia history tint", () => {
    expect(steampunkTheme.history.tint).toMatch(/^#[0-9a-f]{6}$/);
    expect(steampunkTheme.history.desaturate).toBeGreaterThan(0);
    expect(steampunkTheme.history.desaturate).toBeLessThan(1);
  });
});
