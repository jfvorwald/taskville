import type { ProjectState } from "../../data/domain.ts";
import type { CardTarget } from "../../overlays/action-card/index.ts";

/** The parts of a recorded moment the card needs: where it sits in the log and what it opened. */
interface OpenedMoment {
  readonly sequence: number;
  readonly agentId: string | undefined;
  readonly requestId?: string | undefined;
}

const WALK_BUDGET = 64;

/** The count of leading moments whose sequence is at or before `head` (sequences ascend). */
function lastAtOrBefore(list: readonly { readonly sequence: number }[], head: number): number {
  let low = 0;
  let high = list.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((list[mid]?.sequence ?? Number.POSITIVE_INFINITY) <= head) low = mid + 1;
    else high = mid;
  }
  return low;
}

/** True when the moment opened a request the replayed state still holds for the agent. */
function retainedFor(
  moment: OpenedMoment | undefined,
  agentId: string,
  requests: ProjectState["requests"],
): boolean {
  if (moment?.requestId === undefined || moment.agentId !== agentId) return false;
  return (
    Object.hasOwn(requests, moment.requestId) && requests[moment.requestId]?.agentId === agentId
  );
}

/** A request-opening moment reduced to primitives: its place in the log and the request it opened. */
interface Opening {
  readonly sequence: number;
  readonly requestId: string;
}

/** Each agent's openings in ingest order (sequence ascending), built once per published array. */
type OpeningIndex = Map<string, Opening[]>;

// Keyed by array identity, never by length. A moments array is immutable once published: the
// provider hands over a new array when the recording changes, and this index is never rebuilt.
const indexes = new WeakMap<readonly OpenedMoment[], OpeningIndex>();

function openingIndex(moments: readonly OpenedMoment[]): OpeningIndex {
  const cached = indexes.get(moments);
  if (cached !== undefined) return cached;
  const index: OpeningIndex = new Map();
  for (const moment of moments) {
    if (moment.requestId === undefined || moment.agentId === undefined) continue;
    const opening = { sequence: moment.sequence, requestId: moment.requestId };
    const list = index.get(moment.agentId);
    if (list === undefined) index.set(moment.agentId, [opening]);
    else list.push(opening);
  }
  indexes.set(moments, index);
  return index;
}

/**
 * The agent's retained request opened latest at or before the head: bisect the agent's openings to
 * the head, then walk back to the first whose request the replayed state holds for the agent.
 * Every opening is kept, so a duplicated id (the reducer keeps the first) is found from the first.
 * The leftover cost is O(the agent's own openings) primitive lookups with zero moment reads; other
 * agents' requests and merged-away moments are never touched.
 */
function latestRetained(
  moments: readonly OpenedMoment[],
  state: ProjectState,
  agentId: string,
): ProjectState["requests"][string] | undefined {
  const openings = openingIndex(moments).get(agentId);
  if (openings === undefined) return undefined;
  for (let i = lastAtOrBefore(openings, state.head) - 1; i >= 0; i -= 1) {
    const requestId = openings[i]?.requestId;
    if (requestId === undefined || !Object.hasOwn(state.requests, requestId)) continue;
    const request = state.requests[requestId];
    if (request?.agentId === agentId) return request;
  }
  return undefined;
}

/**
 * The request the recording shows for the selected agent at the replayed head: the most recent
 * non-late `request.opened` at or before the head (ingest sequence, not wall clock) whose request
 * the replayed state holds for that agent. A request that has not opened yet is not remembered.
 * The facts are the replayed state's own, so a closed request keeps its final state.
 */
export function recordedCardTarget(args: {
  state: ProjectState | null;
  moments: readonly OpenedMoment[];
  selectedId: string | null;
}): CardTarget | null {
  const { state, moments, selectedId } = args;
  if (state === null || selectedId === null) return null;
  const head = state.head;
  // Moments are in ingest order. A short walk back from the head finds a recent request cheaply;
  // when it does not, the agent's retained requests are resolved through the per-array index, so
  // an agent with no recent (or any) request, or one whose openings were merged away, never costs
  // a walk over the log.
  const start = lastAtOrBefore(moments, head);
  const stop = Math.max(0, start - WALK_BUDGET);
  let request: ProjectState["requests"][string] | undefined;
  let walked = false;
  for (let i = start - 1; i >= stop; i -= 1) {
    const candidate = moments[i];
    if (!retainedFor(candidate, selectedId, state.requests)) continue;
    const requestId = candidate?.requestId;
    request = requestId === undefined ? undefined : state.requests[requestId];
    walked = true;
    break;
  }
  if (!walked) request = latestRetained(moments, state, selectedId);
  if (request !== undefined) {
    return {
      agentId: selectedId,
      agentName: state.agents[selectedId]?.displayName ?? selectedId,
      requestId: request.id,
      sessionId: request.sessionId,
      toolName: request.toolName,
      inputPreview: request.inputPreview,
      reason: request.reason?.text,
      sinceMs: Date.parse(request.openedAt),
      answerable: false,
      requestState: request.state,
      ...(request.heuristic === true ? { heuristic: true } : {}),
    };
  }
  return null;
}
