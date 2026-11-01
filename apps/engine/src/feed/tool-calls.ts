import {
  initialState,
  type ProjectState,
  reduce,
  type ToolCallState,
} from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";

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
  /**
   * `running` until a `tool_call.finished` is recorded; a missing one is never invented. A call
   * the reducer closed at a session boundary with no result is `unfinished`, with `finishedAt`
   * set to the boundary and no `durationMs` (data-model.md "Unfinished tool calls").
   */
  phase: ToolCallState;
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

/**
 * Folds one agent's `tool_call.*` events, in ingest order, into its ToolCalls. Every event of the
 * project must be applied, not only this agent's: a session boundary closes calls with no result,
 * and which calls it closes is the domain reducer's rule, so the tracker runs the reducer beside
 * its own fold and reads the closure from the reducer's state rather than re-implementing it.
 */
export class ToolCallTracker {
  readonly #agentId: string;
  readonly #calls = new Map<string, FeedToolCall>();
  /** IDs of this agent's calls still `running`, so a boundary checks only those. */
  readonly #open = new Set<string>();
  #state: ProjectState;

  constructor(projectId: string, agentId: string) {
    this.#agentId = agentId;
    this.#state = initialState(projectId);
  }

  /**
   * Applies an event. Returns the ToolCall as of this event, or undefined when the event does not
   * change this agent's tool calls (another agent's event, or a repeated start or finish). A
   * boundary closes at most one call per agent (the reducer keeps the latest started of the calls
   * it closes), so one event gives at most one call.
   */
  apply(event: StoredEnvelope): FeedToolCall | undefined {
    this.#state = reduce(this.#state, event);
    const call = this.#fold(event) ?? this.#closedByBoundary(event);
    if (call === undefined) return undefined;
    if (call.phase === "running") this.#open.add(call.toolCallId);
    else this.#open.delete(call.toolCallId);
    return call;
  }

  /** The reducer closed an open call of this agent as `unfinished` at this event. */
  #closedByBoundary(event: StoredEnvelope): FeedToolCall | undefined {
    for (const id of this.#open) {
      const call = this.#calls.get(id);
      const reduced = Object.hasOwn(this.#state.toolCalls, id)
        ? this.#state.toolCalls[id]
        : undefined;
      if (call === undefined || reduced?.phase !== "unfinished") continue;
      const closed: FeedToolCall = { ...call, phase: "unfinished", finishedAt: event.occurredAt };
      this.#calls.set(id, closed);
      return snapshot(closed);
    }
    return undefined;
  }

  #fold(event: StoredEnvelope): FeedToolCall | undefined {
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
      // A recorded result replaces `unfinished`, as in the reducer (M2.13).
      if (
        existing !== undefined &&
        existing.phase !== "running" &&
        existing.phase !== "unfinished"
      ) {
        return undefined;
      }
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
