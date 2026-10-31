import { CITY_LAYOUT } from "../../city/layout/index.ts";
import type { ThemeAccent, ThemeDefinition, ThemeTokens } from "../core/contract.ts";

/**
 * Frutiger Aero (docs/ui/01-minimal-3d-city.png, bottom right): a pale sky-blue world, white
 * buildings with glassy cyan panels, a bright blue water plaza, soft green trees.
 */
const tokens: ThemeTokens = {
  "--tv-scene-bg": "#cfe9fb",
  "--tv-surface": "#eaf6ff",
  "--tv-text": "#0f3f73",
  "--tv-text-muted": "#4a7aa8",
  "--tv-accent": "#1e90e0",
  "--tv-focus": "#ff9f1a",
  "--tv-neon": "#5fd8ff",
  "--tv-radius": "14px",
  "--tv-font": '"Segoe UI", "Frutiger", "Avenir Next", system-ui, sans-serif',
  "--tv-city-wall": "#f4f8fc",
  "--tv-city-roof": "#dbe8f4",
  "--tv-city-accent": "#46b4ee",
  "--tv-city-dark": "#9fb9d0",
  "--tv-city-glass": "#5cc8f4",
  "--tv-city-door": "#58b6e6",
  "--tv-city-ground": "#c3d9ee",
  "--tv-city-street": "#b0cae2",
  "--tv-city-plaza": "#3aa6ee",
  "--tv-city-plaza-mark": "#bfeaff",
  "--tv-city-lamp-pole": "#8fb2cc",
  "--tv-city-lamp-glow": "#e6fbff",
  "--tv-city-tree-trunk": "#6b8a78",
  "--tv-city-tree-crown": "#3fae6a",
  "--tv-city-window-glow": "#fff4c2",
};

/** Night: a deeper dusk blue, the water and glass glow. */
const night: Partial<ThemeTokens> = {
  "--tv-scene-bg": "#1a3a63",
  "--tv-surface": "#16314f",
  "--tv-text": "#dff2ff",
  "--tv-text-muted": "#9cc2e4",
  "--tv-neon": "#8ae8ff",
  "--tv-city-wall": "#aec4da",
  "--tv-city-roof": "#92a9c2",
  "--tv-city-glass": "#7fe0ff",
  "--tv-city-ground": "#7f9cba",
  "--tv-city-street": "#6a89a9",
  "--tv-city-plaza": "#2d8fe0",
  "--tv-city-plaza-mark": "#9fe4ff",
  "--tv-city-lamp-glow": "#fffbe0",
  "--tv-city-window-glow": "#ffeaa0",
};

const ROOF_THICKNESS = 0.25;
const SKIRT = 0.7;

/** Glass panels either side of the door (clear of its 0.7 m half width) and a bright roof edge. */
function glassAccents(): ThemeAccent[] {
  const accents: ThemeAccent[] = [];
  for (const area of CITY_LAYOUT.areas) {
    const { halfX, halfZ } = area.footprint;
    const h = area.height;
    const panelH = h - 1.6;
    const panelX = halfX - 1.0;
    for (const side of [-1, 1]) {
      accents.push({
        id: `${area.id}-glass-${side < 0 ? "l" : "r"}`,
        areas: [area.id],
        tone: "glass",
        glow: false,
        x: side * panelX,
        y: SKIRT + panelH / 2,
        z: halfZ - 0.03,
        sx: 1.0,
        sy: panelH,
        sz: 0.08,
      });
    }
    accents.push({
      id: `${area.id}-roof-edge`,
      areas: [area.id],
      tone: "neon",
      glow: true,
      x: 0,
      y: h + ROOF_THICKNESS + 0.04,
      z: halfZ - 0.06,
      sx: halfX * 2 - 0.3,
      sy: 0.07,
      sz: 0.1,
    });
  }
  return accents;
}

export const aeroTheme: ThemeDefinition = {
  id: "aero",
  name: "Frutiger Aero",
  tokens,
  night,
  history: { tint: "#8fb8d8", desaturate: 0.3 },
  accents: glassAccents(),
  voice: { phrases: {} },
};
