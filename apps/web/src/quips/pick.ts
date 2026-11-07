import type { BreakActivity } from "../city/breaks/types.ts";
import type { Attention } from "../data/domain.ts";
import { hash32 } from "./hash.ts";
import aero from "./phrases/aero.json";
import cyberpunk from "./phrases/cyberpunk.json";
import defaultVoice from "./phrases/default.json";
import solarpunk from "./phrases/solarpunk.json";
import steampunk from "./phrases/steampunk.json";

export type QuipLevel = Attention["level"];

/** A theme's phrase file: attention lines by level, plus the break-time banter and activity lines. */
type Phrases = Readonly<Record<QuipLevel, readonly string[]>> & {
  readonly banter: {
    readonly headlines: readonly string[];
    readonly reactions: readonly string[];
  };
  readonly activities: Readonly<Record<BreakActivity, readonly string[]>>;
};

/** One plain data file per theme id; a theme without one speaks in the default voice. */
const VOICES: ReadonlyMap<string, Phrases> = new Map<string, Phrases>([
  ["aero", aero],
  ["cyberpunk", cyberpunk],
  ["solarpunk", solarpunk],
  ["steampunk", steampunk],
]);

/** The theme's phrases; a theme without a file speaks in the default voice. */
export function voice(theme: string): Phrases {
  return VOICES.get(theme) ?? defaultVoice;
}

export interface QuipInput {
  agentId: string;
  eventId: string;
  level: QuipLevel;
  theme: string;
}

/**
 * The line for a bubble: a pure function of the agent and event IDs, the level, and the theme, so
 * replay shows the same quips as live. Lines come only from the phrase data files.
 */
export function pickQuip({ agentId, eventId, level, theme }: QuipInput): string {
  const lines = voice(theme)[level];
  return lines[hash32(agentId, eventId) % lines.length];
}
