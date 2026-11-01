import { describe, expect, it } from "vitest";
import { DEFAULT_CITY_PALETTE } from "../../../src/city/buildings/index.ts";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";
import {
  applyHistoryTint,
  CITY_PALETTE_KEYS,
  cityPaletteFromTokens,
  cityToken,
  parseHex,
  REQUIRED_TOKENS,
  resolveTokens,
  type ThemeAccent,
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
    expect(Object.keys(otherTheme.tokens).sort()).toEqual(
      Object.keys(cyberpunkTheme.tokens).sort(),
    );
  });

  it("history tint desaturates and tints every palette color, and zero leaves it alone", () => {
    const palette = cityPaletteFromTokens(resolveTokens(cyberpunkTheme, "day"));
    expect(applyHistoryTint(palette, "#00ffff", 0)).toEqual(palette);
    const spread = (hex: string) => {
      const [r, g, b] = parseHex(hex);
      return Math.max(r, g, b) - Math.min(r, g, b);
    };
    const tinted = applyHistoryTint(palette, "#808080", 1);
    for (const key of CITY_PALETTE_KEYS) {
      expect(tinted[key]).not.toBe(palette[key]);
      expect(spread(tinted[key]), key).toBeLessThanOrEqual(spread(palette[key]));
    }
    const half = applyHistoryTint(palette, "#808080", 0.5);
    expect(half.wall).not.toBe(palette.wall);
    expect(half.wall).not.toBe(tinted.wall);
  });

  it("keeps every cyberpunk accent inside the shared footprints and out of navigation clearance", () => {
    expect(validateAccents(CITY_LAYOUT, cyberpunkTheme.accents)).toEqual([]);
  });

  it("rejects an accent that leaves the footprint or blocks a door", () => {
    const outside = validateAccents(CITY_LAYOUT, [
      {
        id: "far",
        areas: ["dispatch"],
        tone: "neon",
        glow: true,
        x: 9,
        y: 2,
        z: 0,
        sx: 1,
        sy: 1,
        sz: 1,
      },
    ]);
    expect(outside.join("\n")).toContain("footprint");
    const door = validateAccents(CITY_LAYOUT, [
      {
        id: "door",
        areas: "all",
        tone: "neon",
        glow: true,
        x: 0,
        y: 0.7,
        z: 2.3,
        sx: 0.4,
        sy: 1.4,
        sz: 0.1,
      },
    ]);
    expect(door.join("\n")).toContain("door");
    const sky = validateAccents(CITY_LAYOUT, [
      {
        id: "sky",
        areas: ["dispatch"],
        tone: "neon",
        glow: true,
        x: 0,
        y: 40,
        z: 0,
        sx: 1,
        sy: 1,
        sz: 1,
      },
    ]);
    expect(sky.join("\n")).toContain("height");
  });

  it("leaves the quip voice slot empty for M4.06", () => {
    expect(cyberpunkTheme.voice.phrases).toEqual({});
  });

  it("keeps the shared building footprints and heights (themes only add accents)", () => {
    expect(
      CITY_LAYOUT.areas.map((a) => ({
        id: a.id,
        cx: a.footprint.cx,
        cz: a.footprint.cz,
        halfX: a.footprint.halfX,
        halfZ: a.footprint.halfZ,
        height: a.height,
      })),
    ).toEqual([
      { id: "dispatch", cx: -10, cz: -10, halfX: 2.4, halfZ: 2.4, height: 5.6 },
      { id: "workshop", cx: 10, cz: -10, halfX: 2.8, halfZ: 2.4, height: 3.2 },
      { id: "test_lab", cx: 10, cz: 0, halfX: 2.4, halfZ: 2.4, height: 3.8 },
      { id: "review", cx: 10, cz: 10, halfX: 2.6, halfZ: 2.6, height: 4.6 },
      { id: "security", cx: -10, cz: 10, halfX: 2.4, halfZ: 2.8, height: 3.4 },
      { id: "archives", cx: -10, cz: 0, halfX: 3.0, halfZ: 2.2, height: 2.6 },
    ]);
  });

  it("lists exactly the keys of the default city palette (CITY_PALETTE_KEYS cannot go stale)", () => {
    expect([...CITY_PALETTE_KEYS].sort()).toEqual(Object.keys(DEFAULT_CITY_PALETTE).sort());
  });

  it("reports a bad night color and names the token", () => {
    const broken = { ...cyberpunkTheme, night: { "--tv-neon": "cyan" } } as never;
    const problems = validateTheme(broken);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("--tv-neon");
  });
});

describe("validateAccents input checks", () => {
  const good: ThemeAccent = {
    id: "ok",
    areas: ["dispatch"],
    tone: "neon",
    glow: true,
    x: 0,
    y: 2,
    z: 0,
    sx: 1,
    sy: 1,
    sz: 1,
  };

  it("accepts the baseline accent used by the cases below", () => {
    expect(validateAccents(CITY_LAYOUT, [good])).toEqual([]);
  });

  it.each([
    ["x is NaN", { x: Number.NaN }],
    ["y is NaN", { y: Number.NaN }],
    ["z is NaN", { z: Number.NaN }],
    ["sx is NaN", { sx: Number.NaN }],
    ["sy is NaN", { sy: Number.NaN }],
    ["sz is NaN", { sz: Number.NaN }],
    ["sx is zero", { sx: 0 }],
    ["sy is zero", { sy: 0 }],
    ["sz is zero", { sz: 0 }],
    ["sx is negative", { sx: -1 }],
    ["sy is negative", { sy: -1 }],
    ["sz is negative", { sz: -1 }],
  ] satisfies Array<[string, Partial<ThemeAccent>]>)(
    "reports a problem when %s",
    (_name, patch) => {
      const problems = validateAccents(CITY_LAYOUT, [{ ...good, id: "bad", ...patch }]);
      expect(problems.length).toBeGreaterThan(0);
      expect(problems.join("\n")).toContain("bad");
    },
  );

  it("reports an unknown area id even when a known one is listed too", () => {
    const problems = validateAccents(CITY_LAYOUT, [
      { ...good, id: "mixed", areas: ["dispatch", "typo" as never] },
    ]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("typo");
  });

  it("reports duplicate accent ids (they collide on the React key)", () => {
    const problems = validateAccents(CITY_LAYOUT, [
      { ...good, id: "twin" },
      { ...good, id: "twin", x: 0.5 },
    ]);
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toMatch(/duplicate/i);
    expect(problems.join("\n")).toContain("twin");
  });
});
