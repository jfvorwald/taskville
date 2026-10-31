import type { Tone } from "./parts.ts";

/**
 * Colors for the city's shared materials. Theme tickets supply their own palette; this default
 * is a calm neutral one. One material per entry is created and shared by every mesh.
 */
export interface CityPalette extends Record<Tone, string> {
  ground: string;
  street: string;
  plaza: string;
  plazaMark: string;
  lampPole: string;
  lampGlow: string;
  treeTrunk: string;
  treeCrown: string;
  windowGlow: string;
}

export const DEFAULT_CITY_PALETTE: CityPalette = {
  wall: "#aab3c2",
  roof: "#7d8798",
  accent: "#6ea8d9",
  dark: "#4b5565",
  glass: "#8fd0e8",
  door: "#39414f",
  ground: "#68758b",
  street: "#3b4453",
  plaza: "#8a97ad",
  plazaMark: "#6ea8d9",
  lampPole: "#2a303a",
  lampGlow: "#f2d48a",
  treeTrunk: "#5b4a3a",
  treeCrown: "#5f9a6a",
  windowGlow: "#e8d9a8",
};
