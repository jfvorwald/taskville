import { CITY_LAYOUT } from "../../city/layout/index.ts";
import type { ThemeAccent, ThemeDefinition, ThemeTokens } from "../core/contract.ts";

/**
 * Steampunk (docs/ui/01-minimal-3d-city.png, top right): a parchment-cream city of warm tan and
 * terracotta brick, brass trim, a clock tower on the tallest building and a brass chimney.
 */
const tokens: ThemeTokens = {
  "--tv-scene-bg": "#f0e6d6",
  "--tv-surface": "#f7efe2",
  "--tv-text": "#4a2f22",
  "--tv-text-muted": "#6a5241",
  "--tv-accent": "#975f22",
  "--tv-focus": "#9d631f",
  "--tv-neon": "#c8913a",
  "--tv-radius": "8px",
  "--tv-font": '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, serif',
  "--tv-city-wall": "#c9a67c",
  "--tv-city-roof": "#9c6a4a",
  "--tv-city-accent": "#a65a3c",
  "--tv-city-dark": "#7a5238",
  "--tv-city-glass": "#e8b45a",
  "--tv-city-door": "#4a3020",
  "--tv-city-ground": "#d8c6a8",
  "--tv-city-street": "#bfae92",
  "--tv-city-plaza": "#cdbb9d",
  "--tv-city-plaza-mark": "#a08060",
  "--tv-city-lamp-pole": "#3a2a20",
  "--tv-city-lamp-glow": "#ffc766",
  "--tv-city-tree-trunk": "#6a4630",
  "--tv-city-tree-crown": "#a8693f",
  "--tv-city-window-glow": "#ffcf7a",
};

/** Night: a dusk-brown sky and panels, dimmer walls, warmer gaslight. */
const night: Partial<ThemeTokens> = {
  "--tv-scene-bg": "#2b1e17",
  "--tv-surface": "#34261d",
  "--tv-text": "#f3e3cc",
  "--tv-text-muted": "#d0bca6",
  "--tv-focus": "#d9892b",
  "--tv-neon": "#ffb54d",
  "--tv-accent": "#e8a24a",
  "--tv-city-wall": "#8a6c4e",
  "--tv-city-roof": "#6c4a34",
  "--tv-city-ground": "#8a7860",
  "--tv-city-street": "#6a5a48",
  "--tv-city-plaza": "#7d6c54",
  "--tv-city-plaza-mark": "#d8a860",
  "--tv-city-lamp-glow": "#ffd080",
  "--tv-city-window-glow": "#ffe0a0",
};

const ROOF_THICKNESS = 0.25;

/** The tallest building carries the clock tower: a crown, a face and a belfry cap. */
function clockTower(): ThemeAccent[] {
  const tallest = [...CITY_LAYOUT.areas].sort((a, b) => b.height - a.height)[0];
  if (tallest === undefined) return [];
  const { halfX, halfZ } = tallest.footprint;
  const h = tallest.height;
  const area = [tallest.id];
  const top = h + ROOF_THICKNESS;
  return [
    {
      id: "clock-crown",
      areas: area,
      tone: "dark",
      glow: false,
      x: 0,
      y: top + 0.35,
      z: 0,
      sx: halfX * 2 - 0.5,
      sy: 0.7,
      sz: halfZ * 2 - 0.5,
    },
    {
      id: "clock-face",
      areas: area,
      tone: "plaza",
      glow: false,
      x: 0,
      y: h - 0.9,
      z: halfZ - 0.02,
      sx: 1.3,
      sy: 1.3,
      sz: 0.08,
    },
    {
      id: "clock-hands",
      areas: area,
      tone: "door",
      glow: false,
      x: 0.12,
      y: h - 0.85,
      z: halfZ,
      sx: 0.5,
      sy: 0.12,
      sz: 0.05,
    },
    {
      id: "clock-hand-up",
      areas: area,
      tone: "door",
      glow: false,
      x: 0,
      y: h - 0.55,
      z: halfZ,
      sx: 0.1,
      sy: 0.6,
      sz: 0.05,
    },
    {
      id: "clock-cap",
      areas: area,
      tone: "neon",
      glow: false,
      x: 0,
      y: top + 0.8,
      z: 0,
      sx: halfX * 2 - 1.4,
      sy: 0.2,
      sz: halfZ * 2 - 1.4,
    },
  ];
}

/** The workshop gets a tall brass chimney with a collar, set at its back corner. */
function chimney(): ThemeAccent[] {
  const workshop = CITY_LAYOUT.areas.find((a) => a.id === "workshop");
  if (workshop === undefined) return [];
  const { halfX, halfZ } = workshop.footprint;
  const h = workshop.height;
  const x = halfX - 0.8;
  const z = -(halfZ - 0.8);
  return [
    {
      id: "chimney-stack",
      areas: ["workshop"],
      tone: "neon",
      glow: false,
      x,
      y: h + ROOF_THICKNESS + 1.3,
      z,
      sx: 0.6,
      sy: 2.6,
      sz: 0.6,
    },
    {
      id: "chimney-collar",
      areas: ["workshop"],
      tone: "dark",
      glow: false,
      x,
      y: h + ROOF_THICKNESS + 2.6,
      z,
      sx: 0.8,
      sy: 0.2,
      sz: 0.8,
    },
  ];
}

/** Brass trim: a thin band along each front roof edge. */
function brassTrim(): ThemeAccent[] {
  return CITY_LAYOUT.areas.map((area) => ({
    id: `${area.id}-brass-band`,
    areas: [area.id],
    tone: "neon" as const,
    glow: false,
    x: 0,
    y: area.height + ROOF_THICKNESS + 0.05,
    z: area.footprint.halfZ - 0.06,
    sx: area.footprint.halfX * 2 - 0.2,
    sy: 0.1,
    sz: 0.12,
  }));
}

export const steampunkTheme: ThemeDefinition = {
  id: "steampunk",
  name: "Steampunk",
  tokens,
  night,
  history: { tint: "#a8814f", desaturate: 0.3 },
  accents: [...brassTrim(), ...clockTower(), ...chimney()],
  voice: { phrases: {} },
};
