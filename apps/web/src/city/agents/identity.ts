import type { AgentView } from "./types.ts";

// Stable colors from identity (ARCHITECTURE 2.1, 2.9). Nothing here reads state that changes
// during a run (activity, attention, display name for non-teammates), so a bot never changes
// color while it works. The hash is FNV-1a: tiny, fast, and the same in every browser.

export interface AgentColors {
  /** Body color, `#rrggbb`. */
  readonly body: string;
  /** Trim (scarf, cap band) color, `#rrggbb`. */
  readonly trim: string;
}

/** The text an agent's colors are derived from. */
export function identityKey(v: AgentView): string {
  if (v.kind === "teammate" && v.displayName !== undefined && v.teamId !== undefined) {
    return `team:${v.teamId}:${v.displayName}`;
  }
  if (v.sourceId !== undefined && v.sourceAgentId !== undefined) {
    return `${v.sourceId}:${v.sourceAgentId}`;
  }
  return `id:${v.id}`;
}

export function agentColors(v: AgentView): AgentColors {
  if (v.kind === "subagent") {
    // One bot per run: body by agent_type, trim by parent, so a family is easy to spot.
    const type = v.agentType ?? identityKey(v);
    return {
      body: colorFrom(`type:${type}`),
      trim:
        v.parentIdentity === undefined
          ? shift(colorFrom(`type:${type}`))
          : colorFrom(v.parentIdentity),
    };
  }
  const body = colorFrom(identityKey(v));
  if ((v.kind === "teammate" || v.kind === "lead") && v.teamId !== undefined) {
    return { body, trim: colorFrom(`scarf:${v.teamId}`) };
  }
  return { body, trim: shift(body) };
}

const HUE_MIN = 55;
const HUE_SPAN = 285;

function fnv1a(text: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
}

function colorFrom(text: string): string {
  const h = fnv1a(text);
  // Hue gets the high bits; saturation and lightness stay in a band that reads on every theme.
  // Red and amber mean "needs you" and "trouble" (ARCHITECTURE 2.2), so identity hues skip
  // [345, 50] and keep a margin inside the band for rounding to hex.
  const hue = HUE_MIN + ((h >>> 8) % HUE_SPAN);
  const sat = 55 + ((h >>> 4) & 0xf);
  const light = 48 + (h & 0xf) / 2;
  return hslToHex(hue, sat, light);
}

/** A darker, hue-shifted companion of a hex color, used when there is no better trim source. */
function shift(hex: string): string {
  const n = Number.parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  const to = (c: number) =>
    Math.round(c * 0.55)
      .toString(16)
      .padStart(2, "0");
  return `#${to(b)}${to(r)}${to(g)}`;
}

function hslToHex(h: number, s: number, l: number): string {
  const sf = s / 100;
  const lf = l / 100;
  const a = sf * Math.min(lf, 1 - lf);
  const channel = (n: number) => {
    const k = (n + h / 30) % 12;
    const v = lf - a * Math.max(-1, Math.min(k - 3, 9 - k, 1));
    return Math.round(v * 255)
      .toString(16)
      .padStart(2, "0");
  };
  return `#${channel(0)}${channel(8)}${channel(4)}`;
}
