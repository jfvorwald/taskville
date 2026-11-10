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
function lastAtOrBefore(list: readonly OpenedMoment[], head: number): number {
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

/** Each agent's request-opening moments by request id, built once per published moments array. */
type OpeningIndex = Map<string, Map<string, OpenedMoment>>;

// Keyed by array identity, never by length. A moments array is immutable once published: the
// provider hands over a new array when the recording changes, and this index is never rebuilt.
const indexes = new WeakMap<readonly OpenedMoment[], OpeningIndex>();

function openingIndex(moments: readonly OpenedMoment[]): OpeningIndex {
  const cached = indexes.get(moments);
  if (cached !== undefined) return cached;
  const index: OpeningIndex = new Map();
  for (const moment of moments) {
    if (moment.requestId === undefined || moment.agentId === undefined) continue;
    const byRequest = index.get(moment.agentId);
    if (byRequest === undefined) index.set(moment.agentId, new Map([[moment.requestId, moment]]));
    else byRequest.set(moment.requestId, moment);
  }
  indexes.set(moments, index);
  return index;
}

/**
 * The retained request of the agent whose opening moment has the greatest sequence at or before
 * the head. Only requests the replayed state holds are looked at, so merged-away openings are
 * never visited and the cost does not depend on how many there are.
 */
function latestRetained(
  moments: readonly OpenedMoment[],
  state: ProjectState,
  agentId: string,
): ProjectState["requests"][string] | undefined {
  const openings = openingIndex(moments).get(agentId);
  if (openings === undefined) return undefined;
  let best: ProjectState["requests"][string] | undefined;
  let bestSequence = Number.NEGATIVE_INFINITY;
  for (const request of Object.values(state.requests)) {
    if (request.agentId !== agentId) continue;
    const opening = openings.get(request.id);
    if (opening === undefined || opening.sequence > state.head) continue;
    if (opening.sequence >= bestSequence) {
      best = request;
      bestSequence = opening.sequence;
    }
  }
  return best;
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
