import type { AttentionLevelView } from "../agents/types.ts";
import type { BreakActivity } from "../breaks/types.ts";

// The small billboard icon over an agent's head (ARCHITECTURE.md 2.3). The level picks the
// family and the kind picks within it.

export type Emote = "!" | "?" | "..." | "zzz" | "sweat" | BreakEmote;

/** The icons that replace the waiting emote while an agent is on break. */
export type BreakEmote = "puff" | "mug" | "sparkle" | "note";

/** The emote for what an agent is doing on its break. */
export function breakEmote(activity: BreakActivity): BreakEmote {
  switch (activity) {
    case "bar":
      return "mug";
    case "smoke":
      return "puff";
    case "stroll":
    case "pigeons":
      return "note";
    case "juggle":
    case "stargaze":
      return "sparkle";
  }
}

export function attentionEmote(
  record: { level: AttentionLevelView; kind: string } | undefined,
  breakActivity?: BreakActivity | null,
): Emote | null {
  if (record === undefined) return null;
  switch (record.level) {
    case "needs_you":
      return "!";
    case "trouble":
      // Silent is a guess, so it asks a question; recorded trouble is a fact.
      return record.kind === "silent" ? "?" : "sweat";
    case "waiting":
      if (breakActivity != null) return breakEmote(breakActivity);
      return record.kind === "idle_prompt" ? "zzz" : "...";
  }
}
