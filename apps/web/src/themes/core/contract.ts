import type { CityPalette } from "../../city/buildings/index.ts";
import type { AreaId, CityLayout } from "../../city/layout/index.ts";
import { HEX_COLOR, mixHex, parseHex, toHex } from "./color.ts";

/**
 * THE THEME CONTRACT. A theme is plain data: one token set, a night override, a history tint,
 * a list of geometric accents and an (empty for now) quip voice. Nothing else varies by theme.
 *
 * - One token set. Every value is a CSS custom property (`--tv-*`). The controller writes the
 *   resolved set onto the document root, so DOM styles read it through `var()`; the 3D materials
 *   are built from the very same resolved set (`cityPaletteFromTokens`). They cannot drift.
 * - Shared footprints. A theme never changes building footprints, heights, the street graph, the
 *   door or the workstation slots (the layout is theme independent). It may only add `accents`,
 *   which `validateAccents` keeps inside the footprint and out of navigation clearance.
 * - Night palette. `night` overrides a subset of tokens when `mode` is "night"; M3.12 (lighting)
 *   drives the mode. Same keys as `tokens`, never new ones.
 * - History tint. `history.tint` and `history.desaturate` describe the mode signal (cool
 *   scanlines for cyberpunk, sepia for steampunk). Applied while history is shown.
 * - Quip voice. `voice.phrases` maps an attention or emote state to lines. Left empty by M3.07;
 *   M4.06 fills it with data.
 */

export type ThemeId = "cyberpunk" | "steampunk" | "solarpunk" | "aero";
export type ThemeMode = "day" | "night";
export type TokenName = `--tv-${string}`;

/** Palette entries of the 3D city (M3.04's `CityPalette`), each published as `--tv-city-<kebab>`. */
export const CITY_PALETTE_KEYS = [
  "wall",
  "roof",
  "accent",
  "dark",
  "glass",
  "door",
  "ground",
  "street",
  "plaza",
  "plazaMark",
  "lampPole",
  "lampGlow",
  "treeTrunk",
  "treeCrown",
  "windowGlow",
] as const satisfies ReadonlyArray<keyof CityPalette>;

export function cityToken(key: keyof CityPalette): TokenName {
  return `--tv-city-${key.replace(/[A-Z]/g, (c) => `-${c.toLowerCase()}`)}`;
}

/** Tokens the DOM overlays read. `--tv-neon` is the theme's glow color (also used by accents). */
export const DOM_TOKENS = [
  "--tv-scene-bg",
  "--tv-surface",
  "--tv-text",
  "--tv-text-muted",
  "--tv-accent",
  "--tv-focus",
  "--tv-neon",
  "--tv-radius",
  "--tv-font",
] as const;

export const REQUIRED_TOKENS: readonly TokenName[] = [
  ...DOM_TOKENS,
  ...CITY_PALETTE_KEYS.map(cityToken),
];

/** Tokens whose value must be a `#rrggbb` color (everything but radius and font). */
const NON_COLOR_TOKENS: ReadonlySet<string> = new Set(["--tv-radius", "--tv-font"]);

export type ThemeTokens = Record<TokenName, string>;

/**
 * A decorative box added to a building: center `(x, z)` relative to the footprint center, `y` is
 * the world height of the box center, sizes in meters. `tone` is a palette entry or `neon`;
 * `glow` draws it unlit (it reads as emission).
 */
export interface ThemeAccent {
  id: string;
  areas: readonly AreaId[] | "all";
  tone: keyof CityPalette | "neon";
  glow: boolean;
  x: number;
  y: number;
  z: number;
  sx: number;
  sy: number;
  sz: number;
}

export interface QuipVoice {
  /** State or emote name to lines. Empty until M4.06. */
  phrases: Readonly<Record<string, readonly string[]>>;
}

export interface HistoryTint {
  /** `#rrggbb` color the city and chrome lean toward while history is shown. */
  tint: string;
  /** 0 keeps colors, 1 is fully grey-and-tinted. Keep it subtle (about 0.2 to 0.45). */
  desaturate: number;
}

export interface ThemeDefinition {
  id: ThemeId;
  name: string;
  tokens: ThemeTokens;
  night: Partial<ThemeTokens>;
  history: HistoryTint;
  accents: readonly ThemeAccent[];
  voice: QuipVoice;
}

export function resolveTokens(theme: ThemeDefinition, mode: ThemeMode): ThemeTokens {
  return mode === "night" ? ({ ...theme.tokens, ...theme.night } as ThemeTokens) : theme.tokens;
}

/** The 3D palette, taken from the resolved token set. */
export function cityPaletteFromTokens(tokens: ThemeTokens): CityPalette {
  const palette = {} as CityPalette;
  for (const key of CITY_PALETTE_KEYS) palette[key] = tokens[cityToken(key)];
  return palette;
}

/** How much of the tint (against grey) a fully history-tinted color carries. */
const TINT_SHARE = 0.35;

/** One color pulled toward a grey of the same brightness, then toward `tint`, by `amount`. */
export function tintHex(hex: string, tint: string, amount: number): string {
  if (amount <= 0) return hex;
  const [r, g, b] = parseHex(hex);
  const grey = 0.299 * r + 0.587 * g + 0.114 * b;
  return mixHex(hex, mixHex(toHex(grey, grey, grey), tint, TINT_SHARE), amount);
}

/** `tintHex` over the whole palette. Zero returns the palette unchanged. */
export function applyHistoryTint(palette: CityPalette, tint: string, amount: number): CityPalette {
  if (amount <= 0) return palette;
  const out = {} as CityPalette;
  for (const key of CITY_PALETTE_KEYS) out[key] = tintHex(palette[key], tint, amount);
  return out;
}

/** Problems with a theme definition, as readable strings. Empty means valid. */
export function validateTheme(theme: ThemeDefinition): string[] {
  const problems: string[] = [];
  const known: ReadonlySet<string> = new Set(REQUIRED_TOKENS);
  for (const name of REQUIRED_TOKENS) {
    const value = theme.tokens[name];
    if (value === undefined || value === "") problems.push(`missing token ${name}`);
    else if (!NON_COLOR_TOKENS.has(name) && !HEX_COLOR.test(value))
      problems.push(`token ${name} is not a #rrggbb color: ${value}`);
  }
  for (const name of Object.keys(theme.tokens)) {
    if (!known.has(name)) problems.push(`unknown token ${name}`);
  }
  for (const [name, value] of Object.entries(theme.night)) {
    if (!known.has(name)) problems.push(`night overrides unknown token ${name}`);
    else if (!NON_COLOR_TOKENS.has(name) && !HEX_COLOR.test(value ?? ""))
      problems.push(`night token ${name} is not a #rrggbb color: ${value}`);
  }
  if (!HEX_COLOR.test(theme.history.tint)) problems.push("history.tint is not a #rrggbb color");
  if (!(theme.history.desaturate >= 0 && theme.history.desaturate <= 1))
    problems.push("history.desaturate must be between 0 and 1");
  return problems;
}

/** Accents may touch the wall plane (windows already sit 0.02 m proud of it). */
export const WALL_TOLERANCE = 0.05;
/** Nothing at the front wall within this half width of the door, below DOOR_CLEARANCE_HEIGHT. */
export const DOOR_CLEARANCE_HALF_WIDTH = 0.7;
export const DOOR_CLEARANCE_HEIGHT = 1.6;
/** Accents stay under the building height plus this many meters. */
export const MAX_ACCENT_RISE = 3;
const FRONT_BAND = 0.5;

/**
 * Checks accents against the shared layout: inside each target's footprint (plus the wall
 * tolerance), clear of the front door, and not taller than the building plus `MAX_ACCENT_RISE`.
 * Because the slots and streets lie outside the footprints, this also keeps navigation clear.
 */
export function validateAccents(layout: CityLayout, accents: readonly ThemeAccent[]): string[] {
  const problems: string[] = [];
  const knownAreas: ReadonlySet<string> = new Set(layout.areas.map((a) => a.id));
  const seen = new Set<string>();
  for (const accent of accents) {
    if (seen.has(accent.id)) problems.push(`duplicate accent id ${accent.id}`);
    seen.add(accent.id);
    for (const key of ["x", "y", "z", "sx", "sy", "sz"] as const) {
      if (!Number.isFinite(accent[key]))
        problems.push(`accent ${accent.id} has a non-finite ${key}`);
    }
    for (const key of ["sx", "sy", "sz"] as const) {
      if (accent[key] <= 0) problems.push(`accent ${accent.id} has a non-positive ${key}`);
    }
    if (accent.areas !== "all") {
      for (const id of accent.areas) {
        if (!knownAreas.has(id)) problems.push(`accent ${accent.id} targets unknown area ${id}`);
      }
    }
    const targets =
      accent.areas === "all"
        ? layout.areas
        : layout.areas.filter((a) => accent.areas.includes(a.id));
    if (targets.length === 0) problems.push(`accent ${accent.id} targets no area`);
    for (const area of targets) {
      const f = area.footprint;
      const tag = `accent ${accent.id} on ${area.id}`;
      if (
        Math.abs(accent.x) + accent.sx / 2 > f.halfX + WALL_TOLERANCE ||
        Math.abs(accent.z) + accent.sz / 2 > f.halfZ + WALL_TOLERANCE
      )
        problems.push(`${tag} leaves the footprint`);
      if (accent.y - accent.sy / 2 < 0) problems.push(`${tag} goes below the ground`);
      if (accent.y + accent.sy / 2 > area.height + MAX_ACCENT_RISE)
        problems.push(`${tag} exceeds the height limit`);
      const onFront = accent.z + accent.sz / 2 > f.halfZ - FRONT_BAND;
      const overDoor =
        accent.x - accent.sx / 2 < DOOR_CLEARANCE_HALF_WIDTH &&
        accent.x + accent.sx / 2 > -DOOR_CLEARANCE_HALF_WIDTH;
      if (onFront && overDoor && accent.y - accent.sy / 2 < DOOR_CLEARANCE_HEIGHT)
        problems.push(`${tag} blocks the door`);
    }
  }
  return problems;
}
