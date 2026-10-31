import type {
  Attention,
  AttentionLevel,
  Connection,
  LastTurn,
  StoredReason,
} from "@taskville/protocol";
import type { PendingRequest } from "../reducer/attention/types.ts";

// Attention selectors (data-model.md "Attention rules"). Attention is derived on read with an
// injected clock and is never stored in reducer state, so it is never part of stateHash.

/** Default "running but silent" threshold: 10 minutes (spec 001). */
export const SILENT_THRESHOLD_MS = 10 * 60_000;

/** The agent fields the attention rules read; the entity reducer's Agent satisfies it. */
export interface AttentionAgent {
  id: string;
  connection: Connection;
  finishedAt?: string;
  lastSeenAt: string;
  consecutiveToolFailures: number;
  lastTurn?: LastTurn;
  /** When the latest turn event happened; `since` falls back to `lastSeenAt` without it. */
  lastTurnAt?: string;
}

/** The slice of ProjectState the attention selectors read. */
export interface AttentionInput {
  agents: Readonly<Record<string, AttentionAgent>>;
  requests: Readonly<Record<string, PendingRequest>>;
}

export interface AttentionOptions {
  /** Quiet time after which a connected agent counts as silent trouble. */
  silentThresholdMs?: number;
}

export interface AttentionCounts {
  needsYou: number;
  trouble: number;
  waiting: number;
}

const TOOL_FAILURE_LIMIT = 3;
const LEVEL_ORDER: Record<AttentionLevel, number> = { needs_you: 0, trouble: 1, waiting: 2 };

/**
 * Every attention record at clock time `now` (milliseconds since the epoch: the engine clock live,
 * the replay clock in history). Sorted `needs_you`, `trouble`, `waiting`, each by `since` in real
 * time, then by agent, kind, and request ID so the order never depends on map key order.
 */
export function attention(
  state: AttentionInput,
  now: number,
  options: AttentionOptions = {},
): Attention[] {
  const threshold = options.silentThresholdMs ?? SILENT_THRESHOLD_MS;
  const records = openRequestRecords(state);
  const needsYou = new Set(records.map((r) => r.agentId));

  for (const agent of Object.values(state.agents)) {
    const turnSince = agent.lastTurnAt ?? agent.lastSeenAt;
    if (agent.lastTurn === "failed") {
      records.push(record(agent.id, "trouble", "stop_failure", turnSince));
    }
    if (agent.consecutiveToolFailures >= TOOL_FAILURE_LIMIT) {
      records.push(record(agent.id, "trouble", "tool_failures", agent.lastSeenAt));
    }
    const waiting = agent.lastTurn === "ended" || agent.lastTurn === "idle_prompt";
    if (agent.lastTurn === "ended") {
      records.push(record(agent.id, "waiting", "turn_ended", turnSince));
    } else if (agent.lastTurn === "idle_prompt") {
      records.push(record(agent.id, "waiting", "idle_prompt", turnSince));
    }
    const quietMs = now - Date.parse(agent.lastSeenAt);
    if (
      agent.connection === "connected" &&
      agent.finishedAt === undefined &&
      !waiting &&
      !needsYou.has(agent.id) &&
      quietMs > threshold
    ) {
      records.push({
        ...record(agent.id, "trouble", "silent", agent.lastSeenAt),
        reason: quietReason(quietMs),
        heuristic: true,
      });
    }
  }
  return records.sort(compare);
}

/** The `needs_you` records only, one per open request. Needs no clock. */
export function needsAttention(state: AttentionInput): Attention[] {
  return openRequestRecords(state).sort(compare);
}

/** How many agents hold at least one record at each level (the `status` header counts). */
export function attentionCounts(
  state: AttentionInput,
  now: number,
  options: AttentionOptions = {},
): AttentionCounts {
  const agents: Record<AttentionLevel, Set<string>> = {
    needs_you: new Set(),
    trouble: new Set(),
    waiting: new Set(),
  };
  for (const r of attention(state, now, options)) agents[r.level].add(r.agentId);
  return {
    needsYou: agents.needs_you.size,
    trouble: agents.trouble.size,
    waiting: agents.waiting.size,
  };
}

function openRequestRecords(state: AttentionInput): Attention[] {
  const records: Attention[] = [];
  for (const request of Object.values(state.requests)) {
    // A late request is stored as expired; the `late` check also guards hand-built state.
    if (request.state !== "open" || request.late) continue;
    records.push({
      ...record(request.agentId, "needs_you", request.kind, request.openedAt),
      ...(request.reason === undefined ? {} : { reason: request.reason }),
      requestId: request.id,
    });
  }
  return records;
}

function record(
  agentId: string,
  level: AttentionLevel,
  kind: Attention["kind"],
  since: string,
): Attention {
  return { agentId, level, kind, since, heuristic: false };
}

/** Generated text for heuristic silent trouble, for example "quiet for 12 min". */
function quietReason(quietMs: number): StoredReason {
  return { text: `quiet for ${Math.floor(quietMs / 60_000)} min`, masked: false, truncated: false };
}

function compare(a: Attention, b: Attention): number {
  return (
    LEVEL_ORDER[a.level] - LEVEL_ORDER[b.level] ||
    Date.parse(a.since) - Date.parse(b.since) ||
    order(a.agentId, b.agentId) ||
    order(a.kind, b.kind) ||
    order(a.requestId ?? "", b.requestId ?? "")
  );
}

const order = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);
