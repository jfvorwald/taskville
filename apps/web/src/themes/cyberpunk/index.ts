import { CITY_LAYOUT } from "../../city/layout/index.ts";
import type { ThemeAccent, ThemeDefinition, ThemeTokens } from "../core/contract.ts";

/**
 * Cyberpunk (docs/ui/01-minimal-3d-city.png, top left): a deep navy night city, slate-blue
 * buildings, cyan neon strips on corners and roof edges, warm window lights.
 */
const tokens: ThemeTokens = {
  "--tv-scene-bg": "#0d1530",
  "--tv-surface": "#151d3a",
  "--tv-text": "#d8e6ff",
  "--tv-text-muted": "#b8c2db",
  "--tv-accent": "#35d6ff",
  "--tv-focus": "#ffb84d",
  "--tv-neon": "#35d6ff",
  "--tv-radius": "4px",
  "--tv-font": '"Avenir Next", "Segoe UI", system-ui, sans-serif',
  "--tv-city-wall": "#5b6a96",
  "--tv-city-roof": "#46547d",
  "--tv-city-accent": "#7a6ad8",
  "--tv-city-dark": "#3a4468",
  "--tv-city-glass": "#4fb8e0",
  "--tv-city-door": "#2a3354",
  "--tv-city-ground": "#4a577f",
  "--tv-city-street": "#2c3556",
  "--tv-city-plaza": "#6571a0",
  "--tv-city-plaza-mark": "#35d6ff",
  "--tv-city-lamp-pole": "#1c2340",
  "--tv-city-lamp-glow": "#5fe3ff",
  "--tv-city-tree-trunk": "#3b3550",
  "--tv-city-tree-crown": "#3f8f86",
  "--tv-city-window-glow": "#ffe0a0",
};

/** Night: deeper sky, dimmer walls, brighter neon and lights. */
const night: Partial<ThemeTokens> = {
  "--tv-scene-bg": "#060a1c",
  "--tv-neon": "#7df4ff",
  "--tv-accent": "#7df4ff",
  "--tv-city-wall": "#3e4a72",
  "--tv-city-roof": "#323d5e",
  "--tv-city-ground": "#343f60",
  "--tv-city-street": "#1f2742",
  "--tv-city-plaza": "#48527a",
  "--tv-city-plaza-mark": "#7df4ff",
  "--tv-city-lamp-glow": "#9af5ff",
  "--tv-city-window-glow": "#fff2c8",
};

// Duplicates ROOF_THICKNESS in buildings/parts.ts; it must change with it.
const ROOF_THICKNESS = 0.25;

/** Neon trims: a strip on each front corner and a thin line along the front roof edge. */
function neonAccents(): ThemeAccent[] {
  const accents: ThemeAccent[] = [];
  for (const area of CITY_LAYOUT.areas) {
    const { halfX, halfZ } = area.footprint;
    const h = area.height;
    accents.push(
      {
        id: `${area.id}-corner`,
        areas: [area.id],
        tone: "neon",
        glow: true,
        x: -(halfX - 0.15),
        y: h / 2,
        z: halfZ - 0.02,
        sx: 0.12,
        sy: h - 0.6,
        sz: 0.08,
      },
      {
        id: `${area.id}-roof-edge`,
        areas: [area.id],
        tone: "neon",
        glow: true,
        x: 0,
        y: h + ROOF_THICKNESS + 0.04,
        z: halfZ - 0.06,
        sx: halfX * 2 - 0.3,
        sy: 0.08,
        sz: 0.1,
      },
    );
  }
  return accents;
}

export const cyberpunkTheme: ThemeDefinition = {
  id: "cyberpunk",
  name: "Cyberpunk",
  tokens,
  night,
  history: { tint: "#4aa8e8", desaturate: 0.3 },
  accents: neonAccents(),
  voice: { phrases: {} },
};
