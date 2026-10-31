import type {
  CommandStatus,
  RequestState,
  StoredEnvelope,
  StoredEnvelopeOf,
} from "@taskville/protocol";
import { BRIDGE_SOURCE_ID, isEngineSource } from "./sources.ts";
import type { Command, PendingRequest, RequestsState } from "./types.ts";

export function initialRequestsState(): RequestsState {
  return { requests: {}, commands: {} };
}

/**
 * Applies one stored envelope to the requests slice. Returns the same object when the event has
 * no effect on requests or commands, and never mutates its inputs.
 */
export function reduceRequests(state: RequestsState, event: StoredEnvelope): RequestsState {
  switch (event.type) {
    case "request.opened":
      return opened(state, event);
    case "request.resolved":
      return isEngineSource(event.sourceId)
        ? close(state, event.payload.requestId, event.payload.resolution)
        : state;
    case "request.expired":
      return isEngineSource(event.sourceId)
        ? close(state, event.payload.requestId, "expired")
        : state;
    case "tool_call.finished":
    case "session.turn_ended":
    case "session.turn_failed":
    case "session.prompt_submitted":
    case "session.ended":
      return event.sessionId === undefined ? state : closeSession(state, event);
    case "command.requested":
      return isEngineSource(event.sourceId) ? commandRequested(state, event) : state;
    case "command.delivered":
    case "command.succeeded":
    case "command.expired":
    case "command.unsupported":
    case "command.failed":
      return isEngineSource(event.sourceId) ? commandMoved(state, event) : state;
    default:
      return state;
  }
}

// --- requests ---------------------------------------------------------------------------------

function opened(state: RequestsState, event: StoredEnvelopeOf<"request.opened">): RequestsState {
  const { payload, agentId, sessionId } = event;
  // The protocol requires agentId on request.opened; the check only narrows the type.
  if (agentId === undefined) return state;
  if (findRequest(state.requests, payload.requestId) !== undefined) return state;

  const late = event.late;
  const request: PendingRequest = {
    id: payload.requestId,
    agentId,
    ...(sessionId === undefined ? {} : { sessionId }),
    kind: payload.kind,
    ...(payload.toolName === undefined ? {} : { toolName: payload.toolName }),
    ...(payload.inputPreview === undefined ? {} : { inputPreview: payload.inputPreview }),
    ...(payload.reason === undefined ? {} : { reason: payload.reason }),
    ...(payload.heuristic === true ? { heuristic: true as const } : {}),
    answerable: !late && event.sourceId === BRIDGE_SOURCE_ID,
    openedAt: event.occurredAt,
    ...(payload.expiresAt === undefined ? {} : { expiresAt: payload.expiresAt }),
    state: late ? "expired" : "open",
    late,
    mergedRequestIds: [],
  };

  const target = late ? undefined : mergeTarget(state.requests, request);
  if (target === undefined) {
    return { ...state, requests: { ...state.requests, [request.id]: request } };
  }

  const workerOverGeneric = request.heuristic === true && target.heuristic !== true;
  if ((request.answerable && !target.answerable) || (workerOverGeneric && !target.answerable)) {
    // The bridge's record wins over telemetry: its preview is the one an Allow would approve, so a
    // forged telemetry preview must never become answerable. A worker prompt (#120) wins over the
    // lead's generic notification so the teammate's name survives either arrival order; it stays
    // labeled heuristic. The red state keeps its first time.
    const { [target.id]: _replaced, ...rest } = state.requests;
    const merged: PendingRequest = {
      ...request,
      openedAt: target.openedAt,
      mergedRequestIds: [...target.mergedRequestIds, target.id],
    };
    return { ...state, requests: { ...rest, [merged.id]: merged } };
  }

  const merged: PendingRequest = {
    ...target,
    mergedRequestIds: [...target.mergedRequestIds, request.id],
  };
  return { ...state, requests: { ...state.requests, [target.id]: merged } };
}

/**
 * "One prompt, one red state": an open permission request with the same session, agent, and tool
 * name (both absent counts as the same). A request without a session never merges, two
 * bridge-held requests never merge, because each holds its own hook response, and two heuristic
 * worker prompts never merge, because each is a different teammate's prompt. Among several
 * candidates the earliest opened wins, then the smallest ID, independent of key order.
 */
function mergeTarget(
  requests: Record<string, PendingRequest>,
  incoming: PendingRequest,
): PendingRequest | undefined {
  if (incoming.kind !== "permission" || incoming.sessionId === undefined) return undefined;
  let best: PendingRequest | undefined;
  for (const candidate of Object.values(requests)) {
    if (
      candidate.state !== "open" ||
      candidate.kind !== "permission" ||
      candidate.sessionId !== incoming.sessionId ||
      candidate.agentId !== incoming.agentId ||
      candidate.toolName !== incoming.toolName ||
      (candidate.answerable && incoming.answerable) ||
      // Two worker prompts (#120) are two teammates' prompts, never one.
      (candidate.heuristic === true && incoming.heuristic === true)
    ) {
      continue;
    }
    if (best === undefined || earlier(candidate, best)) best = candidate;
  }
  return best;
}

function earlier(a: PendingRequest, b: PendingRequest): boolean {
  const byTime = Date.parse(a.openedAt) - Date.parse(b.openedAt);
  return byTime !== 0 ? byTime < 0 : a.id < b.id;
}

/** The record for a request ID, whether it is the record's own ID or one merged into it. */
function findRequest(
  requests: Record<string, PendingRequest>,
  requestId: string,
): PendingRequest | undefined {
  if (Object.hasOwn(requests, requestId)) return requests[requestId];
  return Object.values(requests).find((r) => r.mergedRequestIds.includes(requestId));
}

/** Closes an open request; a request that is already closed keeps its first outcome. */
function close(state: RequestsState, requestId: string, to: RequestState): RequestsState {
  const request = findRequest(state.requests, requestId);
  if (request === undefined || request.state !== "open") return state;
  return { ...state, requests: { ...state.requests, [request.id]: { ...request, state: to } } };
}

/**
 * The next event from the same session closes its open requests (ARCHITECTURE.md section 6):
 * `answered_here` when a Taskville `permission.decide` for the request already succeeded, otherwise
 * `answered_elsewhere`.
 */
function closeSession(state: RequestsState, event: StoredEnvelope): RequestsState {
  let requests: Record<string, PendingRequest> | undefined;
  for (const request of Object.values(state.requests)) {
    if (request.state !== "open" || request.sessionId !== event.sessionId) continue;
    if (!closesRequest(request, event)) continue;
    requests ??= { ...state.requests };
    const to = answeredHere(state.commands, request) ? "answered_here" : "answered_elsewhere";
    requests[request.id] = { ...request, state: to };
  }
  return requests === undefined ? state : { ...state, requests };
}

/**
 * Which same-session events close an open request. Kept as one rule so decision #184 can be
 * switched in one place.
 *
 * #184 D1 (default): a telemetry request (not answerable) closes only on its owning agent's
 * events, or on a session boundary (`session.turn_ended`, `session.prompt_submitted`,
 * `session.ended`) from any agent. Subagents and in-process teammates share their lead's
 * session (S-2), so a subagent's unrelated tool call no longer clears its lead's red state.
 * The D1 alternative (#135 D2, any agent's event closes it) is `return true`. A bridge-held
 * request keeps #135 D2.
 */
export function closesRequest(request: PendingRequest, event: StoredEnvelope): boolean {
  if (request.answerable) return true;
  if (
    event.type === "session.turn_ended" ||
    event.type === "session.prompt_submitted" ||
    event.type === "session.ended"
  ) {
    return true;
  }
  return event.agentId === request.agentId;
}

function answeredHere(commands: Record<string, Command>, request: PendingRequest): boolean {
  return Object.values(commands).some(
    (c) =>
      c.type === "permission.decide" &&
      c.status === "succeeded" &&
      (c.requestId === request.id || request.mergedRequestIds.includes(c.requestId)),
  );
}

// --- commands ---------------------------------------------------------------------------------

function commandRequested(
  state: RequestsState,
  event: StoredEnvelopeOf<"command.requested">,
): RequestsState {
  const { payload } = event;
  if (Object.hasOwn(state.commands, payload.commandId)) return state;
  const command: Command = {
    id: payload.commandId,
    type: payload.commandType,
    requestId: payload.requestId,
    payload: payload.payload,
    status: "requested",
    idempotencyKey: payload.idempotencyKey,
    updatedAt: event.occurredAt,
  };
  return { ...state, commands: { ...state.commands, [command.id]: command } };
}

type CommandMove = StoredEnvelopeOf<
  | "command.delivered"
  | "command.succeeded"
  | "command.expired"
  | "command.unsupported"
  | "command.failed"
>;

/**
 * Allowed transitions (data-model.md): `requested -> delivered -> succeeded | failed | expired`,
 * or straight from `requested` to `unsupported`. `failed` and `expired` may also come straight
 * from `requested`, when the engine finds the request closed or the hold window over before
 * delivery. Success needs delivery first, since acknowledgment is not completion. Terminal
 * statuses are final; any other event is ignored.
 */
const FROM: Record<Exclude<CommandStatus, "requested">, readonly CommandStatus[]> = {
  delivered: ["requested"],
  succeeded: ["delivered"],
  failed: ["requested", "delivered"],
  expired: ["requested", "delivered"],
  unsupported: ["requested"],
};

function commandMoved(state: RequestsState, event: CommandMove): RequestsState {
  const id = event.payload.commandId;
  if (!Object.hasOwn(state.commands, id)) return state;
  const command = state.commands[id] as Command;
  const to = event.type.slice("command.".length) as keyof typeof FROM;
  if (!FROM[to].includes(command.status)) return state;
  const next: Command = {
    ...command,
    status: to,
    updatedAt: event.occurredAt,
    ...(event.type === "command.failed" ? { reason: event.payload.reason } : {}),
  };
  return { ...state, commands: { ...state.commands, [id]: next } };
}
