import { describe, expect, it } from "vitest";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import { parseHex } from "../../../src/themes/core/color.ts";
import {
  CITY_PALETTE_KEYS,
  cityPaletteFromTokens,
  resolveTokens,
  validateAccents,
  validateTheme,
} from "../../../src/themes/core/contract.ts";
import { THEMES } from "../../../src/themes/core/themes.ts";
import { solarpunkTheme } from "../../../src/themes/solarpunk/index.ts";

const lum = (hex: string) => {
  const [r, g, b] = parseHex(hex);
  return 0.299 * r + 0.587 * g + 0.114 * b;
};

describe("solarpunk theme", () => {
  it("passes the theme contract and keeps accents inside the shared footprints", () => {
    expect(solarpunkTheme.id).toBe("solarpunk");
    expect(validateTheme(solarpunkTheme)).toEqual([]);
    expect(validateAccents(CITY_LAYOUT, solarpunkTheme.accents)).toEqual([]);
  });

  it("is registered", () => {
    expect(THEMES.map((t) => t.id)).toContain("solarpunk");
  });

  it("has white blocks, green roofs and a light sky", () => {
    const day = resolveTokens(solarpunkTheme, "day");
    const palette = cityPaletteFromTokens(day);
    expect(lum(palette.wall)).toBeGreaterThan(215);
    const [r, g, b] = parseHex(palette.roof);
    expect(g).toBeGreaterThan(r);
    expect(g).toBeGreaterThan(b);
    expect(lum(day["--tv-scene-bg"])).toBeGreaterThan(220);
  });

  it("grows trees and green on the buildings as accents, on every building", () => {
    const trees = solarpunkTheme.accents.filter((a) => a.tone === "treeCrown");
    expect(trees.length).toBeGreaterThan(0);
    for (const area of CITY_LAYOUT.areas) {
      const onArea = trees.filter((a) => a.areas === "all" || a.areas.includes(area.id));
      expect(onArea.length, area.id).toBeGreaterThan(0);
    }
  });

  it("gives every palette entry a hex color and a darker night", () => {
    const day = resolveTokens(solarpunkTheme, "day");
    const night = resolveTokens(solarpunkTheme, "night");
    for (const key of CITY_PALETTE_KEYS)
      expect(cityPaletteFromTokens(night)[key]).toMatch(/^#[0-9a-f]{6}$/);
    expect(lum(night["--tv-scene-bg"])).toBeLessThan(lum(day["--tv-scene-bg"]));
    expect(solarpunkTheme.history.desaturate).toBeGreaterThan(0);
    expect(solarpunkTheme.history.desaturate).toBeLessThan(1);
  });
});
