import type { Attention } from "../../data/domain.ts";
import { quipVisibleAt } from "../../quips/index.ts";
import type { BubbleCandidate } from "./select.ts";

/** The slice of the store's requests a bubble reads: only the recorded tool name. */
export type RequestTools = Readonly<Record<string, { toolName?: string } | undefined>>;

/**
 * One candidate per agent (its most urgent record; `records` is most urgent first) whose quip
 * window is open at `now`. The event ID is the request ID, or for records with no request the
 * kind and start, which is stable for as long as the state lasts. The tool name comes only from
 * the request's own field, never from any text.
 */
export function bubbleCandidates(
  records: readonly Attention[],
  requests: RequestTools,
  now: number,
): BubbleCandidate[] {
  const seen = new Set<string>();
  const candidates: BubbleCandidate[] = [];
  for (const record of records) {
    if (seen.has(record.agentId)) continue;
    seen.add(record.agentId);
    const sinceMs = Date.parse(record.since);
    if (Number.isNaN(sinceMs)) continue;
    const eventId = record.requestId ?? `${record.kind}@${record.since}`;
    if (!quipVisibleAt({ agentId: record.agentId, eventId, sinceMs }, now)) continue;
    const toolName =
      record.requestId === undefined ? undefined : requests[record.requestId]?.toolName;
    candidates.push({
      agentId: record.agentId,
      eventId,
      level: record.level,
      sinceMs,
      ...(toolName === undefined ? {} : { toolName }),
    });
  }
  return candidates;
}
