import type { BreakActivity, Conversation } from "../city/breaks/types.ts";

/** A banter line and who says it. */
export interface BanterLine {
  speakerId: string;
  line: string;
}

/**
 * The line for a conversation's current turn. Rule: even turns the `a` agent speaks a headline,
 * odd turns the `b` agent reacts. Seeded by (a, b, conversation start, turn), where the start is
 * `turnStartedAt - turn * BUBBLE_TURN_MS`, so replay matches live. Turn t and t + 2 never repeat.
 * RED stub (M9.03): not implemented.
 */
export function pickBanterLine(_input: { conversation: Conversation; theme: string }): BanterLine {
  throw new Error("pickBanterLine not implemented");
}

/** The line for an agent on break with no conversation, seeded by agent id and break start. */
export function pickActivityLine(_input: {
  agentId: string;
  activity: BreakActivity;
  startedAt: number;
  theme: string;
}): string {
  throw new Error("pickActivityLine not implemented");
}
