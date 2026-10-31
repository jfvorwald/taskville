import { describe, expect, it } from "vitest";
import { buildingParts } from "../../../src/city/buildings/parts.ts";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import {
  applyHistoryTint,
  CITY_PALETTE_KEYS,
  cityPaletteFromTokens,
  cityToken,
  REQUIRED_TOKENS,
  resolveTokens,
  validateAccents,
  validateTheme,
} from "../../../src/themes/core/index.ts";
import { cyberpunkTheme } from "../../../src/themes/cyberpunk/index.ts";
import { otherTheme } from "./fixtures.ts";

describe("theme contract", () => {
  it("accepts the cyberpunk theme", () => {
    expect(validateTheme(cyberpunkTheme)).toEqual([]);
  });

  it("reports a missing token, an unknown night override and a bad color", () => {
    const { "--tv-text": _drop, ...rest } = cyberpunkTheme.tokens;
    const broken = {
      ...cyberpunkTheme,
      tokens: { ...rest, "--tv-scene-bg": "navy" },
      night: { "--tv-unknown": "#fff" },
    } as never;
    const problems = validateTheme(broken).join("\n");
    expect(problems).toContain("--tv-text");
    expect(problems).toContain("--tv-unknown");
    expect(problems).toContain("--tv-scene-bg");
  });

  it("requires every city palette key as a token", () => {
    for (const key of CITY_PALETTE_KEYS) expect(REQUIRED_TOKENS).toContain(cityToken(key));
    expect(cityToken("lampGlow")).toBe("--tv-city-lamp-glow");
  });

  it("builds the 3D palette from the same token values the DOM reads", () => {
    const tokens = resolveTokens(cyberpunkTheme, "day");
    const palette = cityPaletteFromTokens(tokens);
    for (const key of CITY_PALETTE_KEYS) expect(palette[key]).toBe(tokens[cityToken(key)]);
  });

  it("night overrides change the palette and day does not", () => {
    const day = resolveTokens(cyberpunkTheme, "day");
    const night = resolveTokens(cyberpunkTheme, "night");
    expect(night["--tv-scene-bg"]).not.toBe(day["--tv-scene-bg"]);
    expect(night["--tv-neon"]).not.toBe(day["--tv-neon"]);
    expect(Object.keys(night).sort()).toEqual(Object.keys(day).sort());
  });

  it("different themes keep the same token key set", () => {
    expect(Object.keys(otherTheme.tokens).sort()).toEqual(Object.keys(cyberpunkTheme.tokens).sort());
  });

  it("history tint desaturates and tints every palette color, and zero leaves it alone", () => {
    const palette = cityPaletteFromTokens(resolveTokens(cyberpunkTheme, "day"));
    expect(applyHistoryTint(palette, "#00ffff", 0)).toEqual(palette);
    const tinted = applyHistoryTint(palette, "#808080", 1);
    for (const key of CITY_PALETTE_KEYS) expect(tinted[key]).toBe("#808080");
    const partial = applyHistoryTint(palette, "#808080", 0.5);
    expect(partial.wall).not.toBe(palette.wall);
    expect(partial.wall).not.toBe("#808080");
  });

  it("keeps every cyberpunk accent inside the shared footprints and out of navigation clearance", () => {
    expect(validateAccents(CITY_LAYOUT, cyberpunkTheme.accents)).toEqual([]);
  });

  it("rejects an accent that leaves the footprint or blocks a door", () => {
    const outside = validateAccents(CITY_LAYOUT, [
      { id: "far", areas: ["dispatch"], tone: "neon", glow: true, x: 9, y: 2, z: 0, sx: 1, sy: 1, sz: 1 },
    ]);
    expect(outside.join("\n")).toContain("footprint");
    const door = validateAccents(CITY_LAYOUT, [
      { id: "door", areas: "all", tone: "neon", glow: true, x: 0, y: 0.7, z: 2.3, sx: 0.4, sy: 1.4, sz: 0.1 },
    ]);
    expect(door.join("\n")).toContain("door");
    const sky = validateAccents(CITY_LAYOUT, [
      { id: "sky", areas: ["dispatch"], tone: "neon", glow: true, x: 0, y: 40, z: 0, sx: 1, sy: 1, sz: 1 },
    ]);
    expect(sky.join("\n")).toContain("height");
  });

  it("leaves the quip voice slot empty for M4.06", () => {
    expect(cyberpunkTheme.voice.phrases).toEqual({});
  });

  it("does not change building footprints (accents are extra parts)", () => {
    for (const area of CITY_LAYOUT.areas) expect(buildingParts(area).length).toBeGreaterThan(2);
  });
});
