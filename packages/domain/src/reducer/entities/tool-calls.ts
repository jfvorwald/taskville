import type { StoredEnvelopeOf } from "@taskville/protocol";
import { clearLastTurn, updateAgent } from "./agents.ts";
import { appendUnique, getOwn, optional, put, removeKeys } from "./maps.ts";
import type { DomainEvent, EntitiesState, ToolCall } from "./types.ts";

// Tool calls, bounded for SC-006: the projection keeps each agent's open calls (at most
// MAX_OPEN_TOOL_CALLS_PER_AGENT, oldest dropped first) plus its latest finished call. Dropped
// calls stay in the event log for the feed (M5); the counters on the agent carry the rest.
//
// A call is counted when its start is seen, never at its finish, so a finish for a call that
// was dropped from the projection cannot count it twice. A finish that arrives before its start
// is recorded as is, and the start fills in its name, paths, and start time when it comes.
// Known limit of the bounded projection: once a call is dropped, a second start for the same
// toolCallId (under a new source event ID) cannot be told from a new call and is counted again.
// Decision ticket #138 (D1) holds the alternative, a bounded per-agent ring of counted IDs.

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
  const existing = getOwn(s.toolCalls, p.toolCallId);
  if (existing?.startedAt !== undefined) return s; // repeated start: already recorded
  if (existing !== undefined && existing.agentId !== agentId) return s; // another agent's call
  const call: ToolCall =
    existing === undefined
      ? {
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
        }
      : {
          // Its finish arrived first: fill in what the start reports, keep the outcome.
          ...existing,
          ...optional("sessionId", existing.sessionId ?? e.sessionId),
          toolName: p.toolName,
          filePaths: existing.filePaths.length > 0 ? existing.filePaths : (p.filePaths ?? []),
          ...optional("summary", existing.summary ?? p.summary),
          evidenceIds: appendUnique(e.evidenceIds, existing.evidenceIds),
          startedAt: e.occurredAt,
        };
  const owner = call.agentId;
  const withCall = { ...s, toolCalls: put(s.toolCalls, call.id, call) };
  const counted = updateAgent(withCall, owner, (agent) =>
    clearLastTurn({ ...agent, toolCallCount: agent.toolCallCount + 1 }, "tool"),
  );
  return call.phase === "running" ? capOpenCalls(counted, owner) : counted;
}

export function applyToolCallFinished(
  s: EntitiesState,
  e: StoredEnvelopeOf<"tool_call.finished">,
  agentId: string,
): EntitiesState {
  const p = e.payload;
  const existing = getOwn(s.toolCalls, p.toolCallId);
  // A repeated finish is ignored; a recorded result replaces `unfinished` (M2.13).
  if (existing !== undefined && existing.phase !== "running" && existing.phase !== "unfinished") {
    return s;
  }
  if (existing !== undefined && existing.agentId !== agentId) return s; // another agent's call
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
      consecutiveToolFailures: p.phase === "failed" ? agent.consecutiveToolFailures + 1 : 0,
    };
    return clearLastTurn(counted, p.phase === "succeeded" ? "tool_succeeded" : "tool");
  });
}

/**
 * Closes running calls that will never get a `tool_call.finished` (data-model.md "Unfinished
 * tool calls", M2.13). `e` is a boundary event of agent `agentId`:
 * - its own running calls in the event's session (all of them for `agent.finished`, or for an
 *   event with no session) close;
 * - when the agent owns the event's session, running calls there of unregistered agents
 *   (internal helpers, S-2) close too;
 * - `session.ended` closes every running call in the session.
 * Closed calls become `unfinished` at the event's time. No counter or turn changes. For each
 * affected agent only the latest started of its closed calls is kept as its finished call.
 */
export function closeUnfinishedCalls(
  s: EntitiesState,
  e: DomainEvent,
  agentId: string,
): EntitiesState {
  const sessionId = e.type === "agent.finished" ? undefined : e.sessionId;
  const ownsSession = sessionId !== undefined && getOwn(s.sessions, sessionId)?.agentId === agentId;
  const closes = (c: ToolCall): boolean => {
    if (c.phase !== "running") return false;
    if (e.type === "session.ended" && sessionId !== undefined && c.sessionId === sessionId) {
      return true;
    }
    const inScope =
      sessionId === undefined || c.sessionId === undefined || c.sessionId === sessionId;
    if (c.agentId === agentId) return inScope;
    if (!ownsSession || c.sessionId !== sessionId) return false;
    return getOwn(s.agents, c.agentId)?.registered !== true;
  };
  const closing = Object.values(s.toolCalls).filter(closes);
  if (closing.length === 0) return s;

  // Per agent, keep the latest started closed call as its one finished call.
  const kept = new Map<string, ToolCall>();
  for (const call of closing) {
    const best = kept.get(call.agentId);
    if (best === undefined || laterStart(call, best)) kept.set(call.agentId, call);
  }
  const drop = new Set<string>();
  for (const c of Object.values(s.toolCalls)) {
    const keep = kept.get(c.agentId);
    if (keep === undefined || c.id === keep.id) continue;
    if (c.phase !== "running" || closing.includes(c)) drop.add(c.id);
  }
  let toolCalls = removeKeys(s.toolCalls, drop);
  for (const call of kept.values()) {
    toolCalls = put(toolCalls, call.id, { ...call, phase: "unfinished", finishedAt: e.occurredAt });
  }
  return { ...s, toolCalls };
}

const laterStart = (a: ToolCall, b: ToolCall): boolean =>
  a.startSeq !== b.startSeq ? a.startSeq > b.startSeq : a.id > b.id;

function capOpenCalls(s: EntitiesState, agentId: string): EntitiesState {
  const open = Object.values(s.toolCalls).filter(
    (c) => c.agentId === agentId && c.phase === "running",
  );
  if (open.length <= MAX_OPEN_TOOL_CALLS_PER_AGENT) return s;
  open.sort((a, b) => a.startSeq - b.startSeq || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const drop = new Set(open.slice(0, open.length - MAX_OPEN_TOOL_CALLS_PER_AGENT).map((c) => c.id));
  return { ...s, toolCalls: removeKeys(s.toolCalls, drop) };
}
