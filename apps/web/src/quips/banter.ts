import { type BreakActivity, BUBBLE_TURN_MS, type Conversation } from "../city/breaks/types.ts";
import { hash32 } from "./hash.ts";
import { voice } from "./pick.ts";

/** A banter line and who says it. */
export interface BanterLine {
  speakerId: string;
  line: string;
}

/**
 * The line for a conversation's current turn. Rule: even turns the `a` agent speaks a headline,
 * odd turns the `b` agent reacts. Seeded by (a, b, conversation start, turn), where the start is
 * `turnStartedAt - turn * BUBBLE_TURN_MS`, so replay matches live. Turn t and t + 2 never repeat:
 * a turn that would land on the same index as two turns ago steps to the next one.
 */
export function pickBanterLine({
  conversation: { a, b, turn, turnStartedAt },
  theme,
}: {
  conversation: Conversation;
  theme: string;
}): BanterLine {
  const { headlines, reactions } = voice(theme).banter;
  const pool = turn % 2 === 0 ? headlines : reactions;
  const start = String(turnStartedAt - turn * BUBBLE_TURN_MS);
  let index = 0;
  let previous = -1;
  for (let t = turn % 2; t <= turn; t += 2) {
    index = hash32(a, b, start, String(t)) % pool.length;
    if (index === previous) index = (index + 1) % pool.length;
    previous = index;
  }
  return { speakerId: turn % 2 === 0 ? a : b, line: pool[index] };
}

/** The line for an agent on break with no conversation, seeded by agent id and break start. */
export function pickActivityLine({
  agentId,
  activity,
  startedAt,
  theme,
}: {
  agentId: string;
  activity: BreakActivity;
  startedAt: number;
  theme: string;
}): string {
  const lines = voice(theme).activities[activity];
  return lines[hash32(agentId, activity, String(startedAt)) % lines.length];
}
