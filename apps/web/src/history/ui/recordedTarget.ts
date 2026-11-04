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

const indexes = new WeakMap<
  readonly OpenedMoment[],
  { length: number; byAgent: Map<string, OpenedMoment[]> }
>();

/** Each agent's request-opening moments, built once per moments list (rebuilt if it grows). */
function agentIndex(moments: readonly OpenedMoment[]): Map<string, OpenedMoment[]> {
  const cached = indexes.get(moments);
  if (cached !== undefined && cached.length === moments.length) return cached.byAgent;
  const byAgent = new Map<string, OpenedMoment[]>();
  for (const moment of moments) {
    if (moment.requestId === undefined || moment.agentId === undefined) continue;
    const list = byAgent.get(moment.agentId);
    if (list === undefined) byAgent.set(moment.agentId, [moment]);
    else list.push(moment);
  }
  indexes.set(moments, { length: moments.length, byAgent });
  return byAgent;
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
  // when it does not, the agent's own request-opening moments are bisected instead, so an agent
  // with no recent (or any) request never costs a walk over the whole log.
  const start = lastAtOrBefore(moments, head);
  let candidates: readonly OpenedMoment[] = moments;
  let from = start;
  const stop = Math.max(0, start - WALK_BUDGET);
  for (let i = start - 1; i >= stop; i -= 1) {
    if (retainedFor(moments[i], selectedId, state.requests)) break;
    if (i === stop) {
      candidates = agentIndex(moments).get(selectedId) ?? [];
      from = lastAtOrBefore(candidates, head);
    }
  }
  for (let i = from - 1; i >= 0; i -= 1) {
    const moment = candidates[i];
    if (moment === undefined || moment.requestId === undefined || moment.agentId !== selectedId)
      continue;
    const request = Object.hasOwn(state.requests, moment.requestId)
      ? state.requests[moment.requestId]
      : undefined;
    if (request === undefined || request.agentId !== selectedId) continue;
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
