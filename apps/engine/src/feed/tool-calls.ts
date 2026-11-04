import {
  callsClosedAtBoundary,
  initialState,
  type ProjectState,
  reduce,
  reduceEntities,
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
 * Folds one agent's `tool_call.*` events, in ingest order, into its ToolCalls. Every event that can
 * matter to the agent must be applied, not only its own (`Storage.agentFeedEvents`): a session boundary closes calls with no result,
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
   * Applies an event. Returns every ToolCall that changed as of this event: none when the event
   * does not change this agent's tool calls (another agent's event, or a repeated start or
   * finish), one for a start or finish, and at a boundary one `unfinished` call for each running
   * call of this agent the reducer closed, oldest start first. The reducer's projection keeps only
   * the latest of them (M5.15), so the closure rule is read from the domain, not from its state.
   */
  applyAll(event: StoredEnvelope): FeedToolCall[] {
    const before = this.#state;
    this.#state = reduce(before, event);
    const folded = this.#fold(event);
    const calls = folded === undefined ? this.#closedByBoundary(before, event) : [folded];
    for (const call of calls) {
      if (call.phase === "running") this.#open.add(call.toolCallId);
      else this.#open.delete(call.toolCallId);
    }
    if (calls.length === 0) this.#restoreRepeatedStart(event);
    this.#forgetDropped();
    return calls;
  }

  /** The last call `applyAll` gives (the latest started at a boundary), or undefined for none. */
  apply(event: StoredEnvelope): FeedToolCall | undefined {
    return this.applyAll(event).at(-1);
  }

  /**
   * A repeated start sends no frame, but if the reducer had dropped the call and holds it running
   * again, the open set must track it again, or a later boundary would close it unannounced.
   */
  #restoreRepeatedStart(event: StoredEnvelope): void {
    if (event.agentId !== this.#agentId || event.type !== "tool_call.started") return;
    const id = event.payload.toolCallId;
    const reduced = Object.hasOwn(this.#state.toolCalls, id)
      ? this.#state.toolCalls[id]
      : undefined;
    if (reduced?.phase === "running" && this.#calls.get(id)?.phase === "running")
      this.#open.add(id);
  }

  /** How many of this agent's calls are tracked as open: never more than the reducer keeps. */
  openCallCount(): number {
    return this.#open.size;
  }

  /**
   * Stops tracking an open call the reducer no longer holds (dropped beyond its per-agent cap, or
   * dropped when a boundary kept only another), so the set stays as small as the reducer's. The
   * frame already sent for it stays as sent.
   */
  #forgetDropped(): void {
    for (const id of this.#open) {
      if (!Object.hasOwn(this.#state.toolCalls, id)) this.#open.delete(id);
    }
  }

  /** The open calls of this agent that the reducer closed as `unfinished` at this event. */
  #closedByBoundary(before: ProjectState, event: StoredEnvelope): FeedToolCall[] {
    // A start never closes a call; it can only drop the oldest open one beyond the cap.
    if (event.agentId === undefined || event.type === "tool_call.started") return [];
    // Nothing open, nothing to close: skip the entity step, which would double every event's cost.
    if (this.#open.size === 0) return [];
    // The reducer closes a call by replacing it, so an event that left toolCalls as they were closed none.
    if (this.#state.toolCalls === before.toolCalls) return [];
    const closed: FeedToolCall[] = [];
    // The reducer's own closure rule, on the state it saw: sessions and agents after the event's
    // entity update (a boundary can first establish session ownership) but before retention (which
    // may drop that owner), over the calls that were running before the event.
    const seen = { ...reduceEntities(before, event), toolCalls: before.toolCalls };
    for (const { id } of callsClosedAtBoundary(seen, event, event.agentId)) {
      const call = this.#calls.get(id);
      if (call === undefined || call.agentId !== this.#agentId || !this.#open.has(id)) continue;
      // Still running afterwards means the event is no boundary.
      const reduced = Object.hasOwn(this.#state.toolCalls, id)
        ? this.#state.toolCalls[id]
        : undefined;
      if (reduced?.phase === "running") continue;
      const next: FeedToolCall = { ...call, phase: "unfinished", finishedAt: event.occurredAt };
      this.#calls.set(id, next);
      closed.push(snapshot(next));
    }
    return closed;
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
