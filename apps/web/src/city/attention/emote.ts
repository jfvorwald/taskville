import type { AttentionLevelView } from "../agents/types.ts";

// The small billboard icon over an agent's head (ARCHITECTURE.md 2.3). The level picks the
// family and the kind picks within it.

export type Emote = "!" | "?" | "..." | "zzz" | "sweat";

export function attentionEmote(
  record: { level: AttentionLevelView; kind: string } | undefined,
): Emote | null {
  if (record === undefined) return null;
  switch (record.level) {
    case "needs_you":
      return "!";
    case "trouble":
      // Silent is a guess, so it asks a question; recorded trouble is a fact.
      return record.kind === "silent" ? "?" : "sweat";
    case "waiting":
      return record.kind === "idle_prompt" ? "zzz" : "...";
  }
}
