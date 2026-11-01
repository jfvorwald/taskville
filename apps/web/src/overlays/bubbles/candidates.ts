import { type Attention, SILENT_THRESHOLD_MS } from "../../data/domain.ts";
import { quipVisibleAt } from "../../quips/index.ts";
import type { BubbleCandidate } from "./select.ts";

/** The slice of the store's requests a bubble reads: only the recorded tool name. */
export type RequestTools = Readonly<Record<string, { toolName?: string } | undefined>>;

/**
 * One candidate per agent (its most urgent record whose quip window is open at `now`;
 * `records` is most urgent first). The event ID is the request ID, or for records with no request the
 * kind and start, which is stable for as long as the state lasts. The tool name comes only from
 * the request's own field, never from any text. A waiting record can only show for the selected
 * agent, so the others are dropped before any scheduling. Silent trouble carries the last-seen
 * time as `since`; its quips run from the onset, `since` plus the silent threshold.
 */
export function bubbleCandidates(
  records: readonly Attention[],
  requests: RequestTools,
  now: number,
  selectedAgentId?: string | null,
): BubbleCandidate[] {
  const seen = new Set<string>();
  const candidates: BubbleCandidate[] = [];
  for (const record of records) {
    if (seen.has(record.agentId)) continue;
    if (record.level === "waiting" && record.agentId !== selectedAgentId) continue;
    const sinceMs = Date.parse(record.since);
    if (Number.isNaN(sinceMs)) continue;
    const eventId = record.requestId ?? `${record.kind}@${record.since}`;
    const startMs = record.kind === "silent" ? sinceMs + SILENT_THRESHOLD_MS : sinceMs;
    if (!quipVisibleAt({ agentId: record.agentId, eventId, sinceMs: startMs }, now)) continue;
    seen.add(record.agentId);
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
