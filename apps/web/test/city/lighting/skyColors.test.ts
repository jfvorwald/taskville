import { describe, expect, it } from "vitest";
import { computeLighting } from "../../../src/city/lighting/phase.ts";
import { lightRig, sunPosition } from "../../../src/city/lighting/skyColors.ts";
import { resolveTokens } from "../../../src/themes/core/contract.ts";
import { cyberpunkTheme } from "../../../src/themes/cyberpunk/index.ts";

const day = resolveTokens(cyberpunkTheme, "day");
const night = resolveTokens(cyberpunkTheme, "night");

describe("lightRig", () => {
  it("uses the theme day sky at noon and the theme night sky at 2 a.m.", () => {
    expect(lightRig(computeLighting(12 * 60), day, night).sky).toBe(day["--tv-scene-bg"]);
    expect(lightRig(computeLighting(2 * 60), day, night).sky).toBe(night["--tv-scene-bg"]);
  });

  it("blends the sky between the two during dusk", () => {
    const sky = lightRig(computeLighting(18 * 60 + 30), day, night).sky;
    expect(sky).not.toBe(day["--tv-scene-bg"]);
    expect(sky).not.toBe(night["--tv-scene-bg"]);
    expect(sky).toMatch(/^#[0-9a-f]{6}$/);
  });

  it("warms the sun at dusk and cools it to moonlight at night", () => {
    const noon = lightRig(computeLighting(12 * 60), day, night).sunColor;
    const dusk = lightRig(computeLighting(18 * 60 + 30), day, night).sunColor;
    const dark = lightRig(computeLighting(2 * 60), day, night).sunColor;
    const blue = (hex: string) => Number.parseInt(hex.slice(5, 7), 16);
    expect(blue(dusk)).toBeLessThan(blue(noon));
    expect(blue(dark)).toBeGreaterThan(blue(dusk));
  });
});

describe("sunPosition", () => {
  it("is overhead at noon (sun angle 90) and low in the east at sunrise", () => {
    const [nx, ny] = sunPosition(90);
    expect(nx).toBeCloseTo(0);
    expect(ny).toBeCloseTo(24);
    const [rx, ry] = sunPosition(0);
    expect(rx).toBeLessThan(0);
    expect(ry).toBeCloseTo(8);
  });

  it("is continuous through sunset and mirrors above the horizon at night", () => {
    const [sx, sy] = sunPosition(180);
    const [ax, ay] = sunPosition(181);
    expect(Math.abs(sx - ax)).toBeLessThan(0.5);
    expect(Math.abs(sy - ay)).toBeLessThan(0.5);
    expect(sunPosition(270)[1]).toBeCloseTo(24);
  });
});
