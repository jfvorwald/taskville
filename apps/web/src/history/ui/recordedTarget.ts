import type { ProjectState } from "../../data/domain.ts";
import type { CardTarget } from "../../overlays/action-card/index.ts";

/** The parts of a recorded moment the card needs: where it sits in the log and what it opened. */
interface OpenedMoment {
  readonly sequence: number;
  readonly agentId: string | undefined;
  readonly requestId?: string | undefined;
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
  // Moments are in ingest order, so the last one at or before the head is found by bisection.
  let low = 0;
  let high = moments.length;
  while (low < high) {
    const mid = (low + high) >>> 1;
    if ((moments[mid]?.sequence ?? Number.POSITIVE_INFINITY) <= state.head) low = mid + 1;
    else high = mid;
  }
  for (let i = low - 1; i >= 0; i -= 1) {
    const moment = moments[i];
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
