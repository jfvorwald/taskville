import type { StoredEnvelope, ToolCallPhase } from "@taskville/protocol";

/**
 * One agent's ToolCall as the feed shows it, as of one event. The same rules as the domain
 * reducer's ToolCall (repeats ignored, a finish may precede its start, nothing invented), but
 * folded here from the event log with no cap: the projection keeps only a bounded set of calls,
 * and the feed must show every call the log holds (ARCHITECTURE.md 2.10).
 */
export interface FeedToolCall {
  toolCallId: string;
  agentId: string;
  /** Absent only for a finish whose start was never seen. */
  toolName?: string;
  /** `running` until a `tool_call.finished` is recorded; a missing one is never invented. */
  phase: ToolCallPhase;
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  filePaths: string[];
}

const snapshot = (call: FeedToolCall): FeedToolCall => ({
  ...call,
  filePaths: [...call.filePaths],
});

/** Folds one agent's `tool_call.*` events, in ingest order, into its ToolCalls. */
export class ToolCallTracker {
  readonly #agentId: string;
  readonly #calls = new Map<string, FeedToolCall>();

  constructor(agentId: string) {
    this.#agentId = agentId;
  }

  /**
   * Applies an event. Returns the ToolCall as of this event, or undefined when the event is not
   * this agent's tool call event or changes nothing (a repeated start or finish).
   */
  apply(event: StoredEnvelope): FeedToolCall | undefined {
    if (event.agentId !== this.#agentId) return undefined;
    if (event.type === "tool_call.started") {
      const p = event.payload;
      const existing = this.#calls.get(p.toolCallId);
      if (existing?.startedAt !== undefined) return undefined;
      const filePaths = existing?.filePaths.length ? existing.filePaths : (p.filePaths ?? []);
      const summary = existing?.summary ?? p.summary;
      const call: FeedToolCall = {
        // Its finish may have arrived first: keep the outcome, fill in what the start reports.
        toolCallId: p.toolCallId,
        agentId: event.agentId,
        phase: existing?.phase ?? "running",
        toolName: p.toolName,
        filePaths: [...filePaths],
        ...(summary === undefined ? {} : { summary }),
        startedAt: event.occurredAt,
        ...(existing?.finishedAt === undefined ? {} : { finishedAt: existing.finishedAt }),
        ...(existing?.durationMs === undefined ? {} : { durationMs: existing.durationMs }),
      };
      this.#calls.set(call.toolCallId, call);
      return snapshot(call);
    }
    if (event.type === "tool_call.finished") {
      const p = event.payload;
      const existing = this.#calls.get(p.toolCallId);
      if (existing !== undefined && existing.phase !== "running") return undefined;
      const summary = p.summary ?? existing?.summary;
      const call: FeedToolCall = {
        toolCallId: p.toolCallId,
        agentId: event.agentId,
        ...(existing?.toolName === undefined ? {} : { toolName: existing.toolName }),
        phase: p.phase,
        ...(existing?.startedAt === undefined ? {} : { startedAt: existing.startedAt }),
        finishedAt: event.occurredAt,
        ...(p.durationMs === undefined ? {} : { durationMs: p.durationMs }),
        ...(summary === undefined ? {} : { summary }),
        filePaths: existing?.filePaths ?? [],
      };
      this.#calls.set(call.toolCallId, call);
      return snapshot(call);
    }
    return undefined;
  }
}
