import { describe, expect, it } from "vitest";
import {
  CITY_PALETTE_KEYS,
  cityPaletteFromTokens,
  resolveTokens,
} from "../../../src/themes/core/index.ts";
import { cyberpunkTheme } from "../../../src/themes/cyberpunk/index.ts";

describe("cyberpunk theme", () => {
  it("is a dark, neon theme with a night palette that is brighter neon", () => {
    expect(cyberpunkTheme.id).toBe("cyberpunk");
    const day = resolveTokens(cyberpunkTheme, "day");
    const night = resolveTokens(cyberpunkTheme, "night");
    const lum = (hex: string) => {
      const n = Number.parseInt(hex.slice(1), 16);
      return ((n >> 16) & 255) + ((n >> 8) & 255) + (n & 255);
    };
    expect(lum(day["--tv-scene-bg"])).toBeLessThan(250);
    expect(lum(night["--tv-neon"])).toBeGreaterThan(lum(day["--tv-neon"]));
  });

  it("gives every palette entry a hex color", () => {
    const palette = cityPaletteFromTokens(resolveTokens(cyberpunkTheme, "night"));
    for (const key of CITY_PALETTE_KEYS) expect(palette[key]).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("has a cool scanline history tint", () => {
    expect(cyberpunkTheme.history.tint).toMatch(/^#[0-9a-f]{6}$/);
    expect(cyberpunkTheme.history.desaturate).toBeGreaterThan(0);
    expect(cyberpunkTheme.history.desaturate).toBeLessThan(1);
  });
});
