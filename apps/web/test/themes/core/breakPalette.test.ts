import { describe, expect, it } from "vitest";
import {
  CITY_PALETTE_KEYS,
  cityPaletteFromTokens,
  cityToken,
  resolveTokens,
  validateTheme,
} from "../../../src/themes/core/contract.ts";
import { THEMES } from "../../../src/themes/core/themes.ts";

// M9.02 assumed palette keys: barCounter, barStool, smokeBench (the smoke lamp reuses lampPole
// and lampGlow). Published as --tv-city-bar-counter, --tv-city-bar-stool, --tv-city-smoke-bench.
const BREAK_KEYS = ["barCounter", "barStool", "smokeBench"] as const;
const HEX = /^#[0-9a-f]{6}$/i;

describe("break prop palette keys", () => {
  it("lists the bar and smoke corner keys in CITY_PALETTE_KEYS", () => {
    for (const key of BREAK_KEYS) expect(CITY_PALETTE_KEYS as readonly string[]).toContain(key);
  });

  it("makes every theme provide a hex color for each key, day and night, and stay valid", () => {
    expect(THEMES.length).toBe(4);
    for (const theme of THEMES) {
      expect(validateTheme(theme), theme.id).toEqual([]);
      for (const mode of ["day", "night"] as const) {
        const tokens = resolveTokens(theme, mode);
        const palette = cityPaletteFromTokens(tokens) as unknown as Record<string, string>;
        for (const key of BREAK_KEYS) {
          const name = cityToken(key as Parameters<typeof cityToken>[0]);
          expect(tokens[name], `${theme.id} ${mode} ${name}`).toMatch(HEX);
          expect(palette[key], `${theme.id} ${mode} ${key}`).toMatch(HEX);
        }
      }
    }
  });
});
