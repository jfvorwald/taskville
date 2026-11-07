import type { AgentBreak, Conversation } from "../../city/breaks/types.ts";
import { pickActivityLine, pickBanterLine } from "../../quips/banter.ts";
import {
  type Bubble,
  type BubbleCandidate,
  MAX_BUBBLES,
  type SelectOptions,
  selectBubbles,
} from "./select.ts";

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

const byPair = (x: Conversation, y: Conversation): number =>
  x.a < y.a ? -1 : x.a > y.a ? 1 : x.b < y.b ? -1 : x.b > y.b ? 1 : 0;

/**
 * `selectBubbles` plus break-time bubbles, at most three in all. Order: needs-you, trouble and the
 * selected agent's waiting bubble (as selectBubbles), then the selected agent's activity line (only
 * if it is on break with no conversation), then one conversation's current speaker (lowest `a`,
 * then `b`). An agent shows once.
 */
export function selectBubblesWithBreaks(
  candidates: readonly BubbleCandidate[],
  { conversations, agents, chatterEnabled }: BreakBubbleInput,
  options: SelectOptions,
): (Bubble | BreakBubble)[] {
  const bubbles: (Bubble | BreakBubble)[] = selectBubbles(candidates, options);
  const shown = new Set(bubbles.map((b) => b.agentId));
  const { selectedAgentId, theme } = options;

  const onBreak = selectedAgentId ? agents.get(selectedAgentId) : undefined;
  const talking = conversations.some((c) => c.a === selectedAgentId || c.b === selectedAgentId);
  if (
    selectedAgentId &&
    onBreak &&
    !talking &&
    !shown.has(selectedAgentId) &&
    bubbles.length < MAX_BUBBLES
  ) {
    shown.add(selectedAgentId);
    bubbles.push({
      agentId: selectedAgentId,
      level: "activity",
      line: pickActivityLine({
        agentId: selectedAgentId,
        activity: onBreak.activity,
        startedAt: onBreak.startedAt,
        theme,
      }),
      fact: null,
    });
  }

  const first = chatterEnabled ? [...conversations].sort(byPair)[0] : undefined;
  if (first && bubbles.length < MAX_BUBBLES) {
    const { speakerId, line } = pickBanterLine({ conversation: first, theme });
    if (!shown.has(speakerId)) {
      bubbles.push({ agentId: speakerId, level: "chatter", line, fact: null });
    }
  }
  return bubbles;
}
