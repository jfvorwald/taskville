import { pickQuip, type QuipLevel } from "../../quips/index.ts";
import { bubbleFact } from "./fact.ts";

/** Most bubbles on screen at once. */
export const MAX_BUBBLES = 3;

/** One agent's current attention record, as far as a bubble needs it. */
export interface BubbleCandidate {
  agentId: string;
  /** The record's opening event or request ID: seeds the line. */
  eventId: string;
  level: QuipLevel;
  /** When the state began, on the same clock as `now`. */
  sinceMs: number;
  /** The request's recorded tool name; checked before use. */
  toolName?: string;
}

export interface Bubble {
  agentId: string;
  level: QuipLevel;
  line: string;
  fact: string | null;
}

export interface SelectOptions {
  selectedAgentId: string | null | undefined;
  /** The clock `sinceMs` is on. The wait is `now - sinceMs`, so ranking by it is ranking by start. */
  now: number;
  theme: string;
}

const RANK: Record<QuipLevel, number> = { needs_you: 0, trouble: 1, waiting: 2 };

/**
 * The bubbles to show, at most three: needs-you by longest wait, then trouble by longest wait,
 * then the selected agent. A waiting agent shows only when selected; an agent shows once. Ties
 * break by agent ID. The result carries a phrase line and an allowlisted fact, nothing else.
 */
export function selectBubbles(
  candidates: readonly BubbleCandidate[],
  { selectedAgentId, theme }: SelectOptions,
): Bubble[] {
  const shown = candidates
    .filter((c) => c.level !== "waiting" || c.agentId === selectedAgentId)
    .sort(
      (a, b) =>
        RANK[a.level] - RANK[b.level] ||
        // Longest wait first: the earlier start.
        a.sinceMs - b.sinceMs ||
        (a.agentId < b.agentId ? -1 : a.agentId > b.agentId ? 1 : 0),
    );
  const seen = new Set<string>();
  const bubbles: Bubble[] = [];
  for (const c of shown) {
    if (bubbles.length === MAX_BUBBLES) break;
    if (seen.has(c.agentId)) continue;
    seen.add(c.agentId);
    bubbles.push({
      agentId: c.agentId,
      level: c.level,
      line: pickQuip({ agentId: c.agentId, eventId: c.eventId, level: c.level, theme }),
      fact: bubbleFact({ level: c.level, toolName: c.toolName }),
    });
  }
  return bubbles;
}
