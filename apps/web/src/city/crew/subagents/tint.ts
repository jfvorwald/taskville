import type { Attention } from "../../../data/domain.ts";
import { attentionPulse, type PulseHue } from "../../attention/pulse.ts";

// A subagent is drawn only as a crew bot, so the bot carries the attention signal a block agent
// would get: red when it needs you, amber when it is in trouble, nothing for waiting. The hue is
// the one `attentionPulse` gives a block agent, so the two cannot drift apart.

export interface CrewBotTint {
  readonly level: "needs_you" | "trouble";
  readonly hue: PulseHue;
}

/** The same two hues the stuck rings use (`attention/resources.ts`), the body color while stuck. */
export const TINT_HEX: Record<PulseHue, string> = { red: "#e5484d", amber: "#f5a524" };

const STEADY = { elapsedMs: 0, reducedMotion: true } as const;

/** The tint for one subagent from the store's attention records (most urgent first). */
export function crewBotTint(
  agent: { id: string },
  attention: readonly Attention[],
): CrewBotTint | undefined {
  const record = attention.find((a) => a.agentId === agent.id);
  if (record === undefined || record.level === "waiting") return undefined;
  const hue = attentionPulse(record.level, STEADY).hue;
  return hue === null ? undefined : { level: record.level, hue };
}
