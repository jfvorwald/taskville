import { MeshBasicMaterial } from "three";
import { describe, expect, it } from "vitest";
import { applyEmissiveLevel } from "../../../src/city/buildings/materials.ts";
import { DEFAULT_CITY_PALETTE } from "../../../src/city/buildings/palette.ts";

const palette = DEFAULT_CITY_PALETTE;

function glowMaterials() {
  return {
    windowGlow: new MeshBasicMaterial({ color: palette.windowGlow }),
    lampGlow: new MeshBasicMaterial({ color: palette.lampGlow }),
  };
}

const channels = (m: MeshBasicMaterial) => [m.color.r, m.color.g, m.color.b];

describe("applyEmissiveLevel", () => {
  it("at level 1 the glow colors equal the palette hexes", () => {
    const glow = glowMaterials();
    applyEmissiveLevel(glow, 0.2, palette);
    applyEmissiveLevel(glow, 1, palette);
    expect(glow.windowGlow.color.getHexString()).toBe(palette.windowGlow.slice(1));
    expect(glow.lampGlow.color.getHexString()).toBe(palette.lampGlow.slice(1));
  });

  it("at level 0.2 both windows and lamps are darker than the palette, every channel", () => {
    const glow = glowMaterials();
    const fullWindow = channels(glow.windowGlow);
    const fullLamp = channels(glow.lampGlow);
    applyEmissiveLevel(glow, 0.2, palette);
    channels(glow.windowGlow).forEach((c, i) => {
      expect(c).toBeLessThan(fullWindow[i] as number);
    });
    channels(glow.lampGlow).forEach((c, i) => {
      expect(c).toBeLessThan(fullLamp[i] as number);
    });
  });

  it("gets brighter as the level rises (0.2 < 0.6 < 1)", () => {
    const glow = glowMaterials();
    const sum = (m: MeshBasicMaterial) => m.color.r + m.color.g + m.color.b;
    applyEmissiveLevel(glow, 0.2, palette);
    const low = [sum(glow.windowGlow), sum(glow.lampGlow)];
    applyEmissiveLevel(glow, 0.6, palette);
    const mid = [sum(glow.windowGlow), sum(glow.lampGlow)];
    applyEmissiveLevel(glow, 1, palette);
    const high = [sum(glow.windowGlow), sum(glow.lampGlow)];
    for (const i of [0, 1]) {
      expect(low[i]).toBeLessThan(mid[i] as number);
      expect(mid[i]).toBeLessThan(high[i] as number);
    }
  });

  it("scales relative to the palette, not the current color (no drift on repeat)", () => {
    const glow = glowMaterials();
    applyEmissiveLevel(glow, 0.3, palette);
    const once = channels(glow.windowGlow);
    applyEmissiveLevel(glow, 0.3, palette);
    applyEmissiveLevel(glow, 0.3, palette);
    expect(channels(glow.windowGlow)).toEqual(once);
  });

  it("keeps the hue: dimmed channels keep the palette's channel order", () => {
    const glow = glowMaterials();
    applyEmissiveLevel(glow, 0.4, palette);
    const [r, g, b] = channels(glow.lampGlow) as [number, number, number];
    // #f2d48a: red > green > blue.
    expect(r).toBeGreaterThan(g);
    expect(g).toBeGreaterThan(b);
  });
});
