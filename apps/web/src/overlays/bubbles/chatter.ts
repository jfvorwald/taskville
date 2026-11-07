import type { AgentBreak, Conversation } from "../../city/breaks/types.ts";
import type { Bubble, BubbleCandidate, SelectOptions } from "./select.ts";

/** A break-time bubble: a conversation speaker's line or a selected agent's activity line. */
export interface BreakBubble {
  agentId: string;
  level: "chatter" | "activity";
  line: string;
  fact: null;
}

export interface BreakBubbleInput {
  conversations: readonly Conversation[];
  agents: ReadonlyMap<string, AgentBreak>;
  /** The chatter setting (wired by M9.04). Off drops conversation bubbles. */
  chatterEnabled: boolean;
}

/**
 * `selectBubbles` plus break-time bubbles, at most three in all. Order: needs-you, trouble and the
 * selected agent's waiting bubble (as selectBubbles), then the selected agent's activity line (only
 * if it is on break with no conversation), then one conversation's current speaker (lowest `a`,
 * then `b`). RED stub (M9.03): not implemented.
 */
export function selectBubblesWithBreaks(
  _candidates: readonly BubbleCandidate[],
  _breaks: BreakBubbleInput,
  _options: SelectOptions,
): (Bubble | BreakBubble)[] {
  throw new Error("selectBubblesWithBreaks not implemented");
}
