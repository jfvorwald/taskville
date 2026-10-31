import { CITY_LAYOUT } from "../../city/layout/index.ts";
import type { ThemeAccent, ThemeDefinition, ThemeTokens } from "../core/contract.ts";

/**
 * Solarpunk (docs/ui/01-minimal-3d-city.png, bottom left): a warm off-white day, white blocks
 * with green roofs, trees and hedges growing on and around the buildings.
 */
const tokens: ThemeTokens = {
  "--tv-scene-bg": "#f6f3ea",
  "--tv-surface": "#fbf9f2",
  "--tv-text": "#27432f",
  "--tv-text-muted": "#5f7a62",
  "--tv-accent": "#4f9a3f",
  "--tv-focus": "#e8a31c",
  "--tv-neon": "#8fd14f",
  "--tv-radius": "10px",
  "--tv-font": '"Avenir Next", "Segoe UI", system-ui, sans-serif',
  "--tv-city-wall": "#fffdf4",
  "--tv-city-roof": "#8cc455",
  "--tv-city-accent": "#4f9a3f",
  "--tv-city-dark": "#cfc8b6",
  "--tv-city-glass": "#8fb9b0",
  "--tv-city-door": "#3f7a52",
  "--tv-city-ground": "#f2efe4",
  "--tv-city-street": "#dedacd",
  "--tv-city-plaza": "#f6f3e9",
  "--tv-city-plaza-mark": "#6bb04a",
  "--tv-city-lamp-pole": "#3c4a3e",
  "--tv-city-lamp-glow": "#fff0b3",
  "--tv-city-tree-trunk": "#7a5a3a",
  "--tv-city-tree-crown": "#5fae3f",
  "--tv-city-window-glow": "#ffe9a8",
};

/** Night: a deep green dusk, dimmer walls, warmer lamps and windows. */
const night: Partial<ThemeTokens> = {
  "--tv-scene-bg": "#1b2a22",
  "--tv-city-wall": "#a9ae9f",
  "--tv-city-roof": "#4f7a33",
  "--tv-city-ground": "#7d8576",
  "--tv-city-street": "#59614f",
  "--tv-city-plaza": "#899181",
  "--tv-city-tree-crown": "#3c7a2d",
  "--tv-city-lamp-glow": "#ffe58a",
  "--tv-city-window-glow": "#ffe08a",
};

const ROOF_THICKNESS = 0.25;

/**
 * Green on every building: a rooftop tree in the back corner (trunk and crown), a rooftop
 * planter along the back edge, and a hedge at each front corner (clear of the door).
 */
function greenAccents(): ThemeAccent[] {
  const accents: ThemeAccent[] = [];
  for (const area of CITY_LAYOUT.areas) {
    const { halfX, halfZ } = area.footprint;
    const top = area.height + ROOF_THICKNESS;
    const tx = halfX - 0.8;
    const tz = -(halfZ - 0.8);
    accents.push(
      {
        id: `${area.id}-roof-trunk`,
        areas: [area.id],
        tone: "treeTrunk",
        glow: false,
        x: tx,
        y: top + 0.25,
        z: tz,
        sx: 0.22,
        sy: 0.5,
        sz: 0.22,
      },
      {
        id: `${area.id}-roof-tree`,
        areas: [area.id],
        tone: "treeCrown",
        glow: false,
        x: tx,
        y: top + 0.5 + 0.45,
        z: tz,
        sx: 0.95,
        sy: 0.9,
        sz: 0.95,
      },
      {
        id: `${area.id}-roof-planter`,
        areas: [area.id],
        tone: "accent",
        glow: false,
        x: -(halfX - 1.4),
        y: top + 0.15,
        z: -(halfZ - 0.5),
        sx: 1.8,
        sy: 0.3,
        sz: 0.6,
      },
    );
    for (const side of [-1, 1]) {
      accents.push({
        id: `${area.id}-hedge-${side < 0 ? "w" : "e"}`,
        areas: [area.id],
        tone: "treeCrown",
        glow: false,
        x: side * (halfX - 0.65),
        y: 0.3,
        z: halfZ - 0.2,
        sx: 0.9,
        sy: 0.6,
        sz: 0.4,
      });
    }
  }
  return accents;
}

export const solarpunkTheme: ThemeDefinition = {
  id: "solarpunk",
  name: "Solarpunk",
  tokens,
  night,
  history: { tint: "#c9b37a", desaturate: 0.3 },
  accents: greenAccents(),
  voice: { phrases: {} },
};
