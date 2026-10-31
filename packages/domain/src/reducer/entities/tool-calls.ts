import type { StoredEnvelopeOf } from "@taskville/protocol";
import { clearLastTurn, updateAgent } from "./agents.ts";
import { appendUnique, getOwn, optional, put, removeKeys } from "./maps.ts";
import type { EntitiesState, ToolCall } from "./types.ts";

// Tool calls, bounded for SC-006: the projection keeps each agent's open calls (at most
// MAX_OPEN_TOOL_CALLS_PER_AGENT, oldest dropped first) plus its latest finished call. Dropped
// calls stay in the event log for the feed (M5); the counters on the agent carry the rest.

/**
 * Open calls kept per agent. A PreToolUse with no PostToolUse is real (S-2: internal helper
 * agents), so open calls must be capped too, not only finished ones.
 */
export const MAX_OPEN_TOOL_CALLS_PER_AGENT = 32;

export function applyToolCallStarted(
  s: EntitiesState,
  e: StoredEnvelopeOf<"tool_call.started">,
  agentId: string,
): EntitiesState {
  const p = e.payload;
  if (Object.hasOwn(s.toolCalls, p.toolCallId)) return s; // repeated start: already recorded
  const call: ToolCall = {
    id: p.toolCallId,
    agentId,
    ...optional("sessionId", e.sessionId),
    toolName: p.toolName,
    phase: "running",
    filePaths: p.filePaths ?? [],
    ...optional("summary", p.summary),
    evidenceIds: appendUnique([], e.evidenceIds),
    startedAt: e.occurredAt,
    startSeq: e.ingestSequence,
  };
  const withCall = { ...s, toolCalls: put(s.toolCalls, call.id, call) };
  const counted = updateAgent(withCall, agentId, (agent) =>
    clearLastTurn({ ...agent, toolCallCount: agent.toolCallCount + 1 }, "tool"),
  );
  return capOpenCalls(counted, agentId);
}

export function applyToolCallFinished(
  s: EntitiesState,
  e: StoredEnvelopeOf<"tool_call.finished">,
  agentId: string,
): EntitiesState {
  const p = e.payload;
  const existing = getOwn(s.toolCalls, p.toolCallId);
  if (existing !== undefined && existing.phase !== "running") return s; // repeated finish
  const summary = p.summary ?? existing?.summary;
  const finished: ToolCall =
    existing === undefined
      ? {
          // The start was never seen: record what the finish says and invent nothing else.
          id: p.toolCallId,
          agentId,
          ...optional("sessionId", e.sessionId),
          phase: p.phase,
          filePaths: [],
          ...optional("summary", summary),
          evidenceIds: appendUnique([], e.evidenceIds),
          finishedAt: e.occurredAt,
          ...optional("durationMs", p.durationMs),
          startSeq: e.ingestSequence,
        }
      : {
          ...existing,
          phase: p.phase,
          ...optional("summary", summary),
          evidenceIds: appendUnique(existing.evidenceIds, e.evidenceIds),
          finishedAt: e.occurredAt,
          ...optional("durationMs", p.durationMs),
        };
  const owner = finished.agentId;

  // Keep only this call as the owner's latest finished call.
  const stale = new Set(
    Object.values(s.toolCalls)
      .filter((c) => c.agentId === owner && c.phase !== "running" && c.id !== finished.id)
      .map((c) => c.id),
  );
  const toolCalls = put(removeKeys(s.toolCalls, stale), finished.id, finished);
  return updateAgent({ ...s, toolCalls }, owner, (agent) => {
    const counted = {
      ...agent,
      toolCallCount: agent.toolCallCount + (existing === undefined ? 1 : 0),
      consecutiveToolFailures: p.phase === "failed" ? agent.consecutiveToolFailures + 1 : 0,
    };
    return clearLastTurn(counted, p.phase === "succeeded" ? "tool_succeeded" : "tool");
  });
}

function capOpenCalls(s: EntitiesState, agentId: string): EntitiesState {
  const open = Object.values(s.toolCalls).filter(
    (c) => c.agentId === agentId && c.phase === "running",
  );
  if (open.length <= MAX_OPEN_TOOL_CALLS_PER_AGENT) return s;
  open.sort((a, b) => a.startSeq - b.startSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const drop = new Set(open.slice(0, open.length - MAX_OPEN_TOOL_CALLS_PER_AGENT).map((c) => c.id));
  return { ...s, toolCalls: removeKeys(s.toolCalls, drop) };
}
