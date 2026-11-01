import type { OverlayMode } from "../host/types.ts";

/** The card's two engine calls and their request bodies (contracts/http-api.md). */

const SESSION_HEADER = "X-Taskville-Session";

export interface DecideBody {
  type: "permission.decide";
  projectId: string;
  requestId: string;
  idempotencyKey: string;
  context: { mode: OverlayMode };
  decision: { behavior: "allow" } | { behavior: "deny"; message?: string };
}

export interface OpenBody {
  type: "session.open";
  projectId: string;
  requestId: string;
  sessionId: string;
  idempotencyKey: string;
  context: { mode: OverlayMode };
}

export type CommandBody = DecideBody | OpenBody;

export function buildDecideBody(args: {
  projectId: string;
  requestId: string;
  idempotencyKey: string;
  mode: OverlayMode;
  behavior: "allow" | "deny";
  note?: string | undefined;
}): DecideBody {
  const { projectId, requestId, idempotencyKey, mode, behavior } = args;
  const message = args.note?.trim();
  const decision =
    behavior === "deny" && message
      ? ({ behavior: "deny", message } as const)
      : ({ behavior } as const);
  return {
    type: "permission.decide",
    projectId,
    requestId,
    idempotencyKey,
    context: { mode },
    decision,
  };
}

export function buildOpenBody(args: {
  projectId: string;
  requestId: string;
  sessionId: string;
  idempotencyKey: string;
  mode: OverlayMode;
}): OpenBody {
  const { projectId, requestId, sessionId, idempotencyKey, mode } = args;
  return {
    type: "session.open",
    projectId,
    requestId,
    sessionId,
    idempotencyKey,
    context: { mode },
  };
}

/** The request as the bridge holds it (`GET /v1/requests/:requestId/input`). */
export interface HeldRequest {
  requestId: string;
  projectId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  cwd?: string;
}

export type ExactInputResult =
  | { kind: "ok"; input: HeldRequest }
  | { kind: "expired" }
  | { kind: "unknown" }
  | { kind: "failed" };

function isHeldRequest(value: unknown): value is HeldRequest {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.requestId === "string" &&
    typeof v.projectId === "string" &&
    typeof v.sessionId === "string" &&
    typeof v.toolName === "string" &&
    "toolInput" in v &&
    (v.cwd === undefined || typeof v.cwd === "string")
  );
}

/** Asks the bridge for the exact, unredacted input of a held request. */
export async function fetchExactInput(args: {
  fetch: typeof fetch;
  secret: string;
  projectId: string;
  requestId: string;
  signal?: AbortSignal | undefined;
}): Promise<ExactInputResult> {
  const { secret, projectId, requestId, signal } = args;
  const url = `/v1/requests/${encodeURIComponent(requestId)}/input?projectId=${encodeURIComponent(projectId)}`;
  try {
    const response = await args.fetch(url, {
      headers: { [SESSION_HEADER]: secret },
      ...(signal === undefined ? {} : { signal }),
    });
    if (response.status === 410) return { kind: "expired" };
    if (response.status === 404) return { kind: "unknown" };
    if (!response.ok) return { kind: "failed" };
    const body: unknown = await response.json();
    // The body must be for the request that was asked about.
    return isHeldRequest(body) && body.requestId === requestId
      ? { kind: "ok", input: body }
      : { kind: "failed" };
  } catch {
    return { kind: "failed" };
  }
}

/** A command as the engine returns it. `result` is only on a succeeded `session.open`. */
export interface CommandRecord {
  id: string;
  type?: string;
  requestId?: string;
  status: string;
  result?: { outcome?: string; sessionId?: string; cwd?: string };
}

export type SendResult =
  | { ok: true; command: CommandRecord }
  | { ok: false; code: string; status: number };

/** POSTs one command. Only the error code and status come back, never the server's text. */
export async function sendCommand(args: {
  fetch: typeof fetch;
  secret: string;
  body: CommandBody;
  signal?: AbortSignal | undefined;
}): Promise<SendResult> {
  let response: Response;
  try {
    response = await args.fetch("/v1/commands", {
      method: "POST",
      headers: { [SESSION_HEADER]: args.secret, "Content-Type": "application/json" },
      body: JSON.stringify(args.body),
      ...(args.signal === undefined ? {} : { signal: args.signal }),
    });
  } catch {
    return { ok: false, code: "network", status: 0 };
  }
  const status = response.status;
  let parsed: unknown;
  try {
    parsed = await response.json();
  } catch {
    return { ok: false, code: "unknown", status };
  }
  const body = (typeof parsed === "object" && parsed !== null ? parsed : {}) as {
    command?: unknown;
    error?: { code?: unknown };
  };
  if (response.ok) {
    const command = body.command;
    return typeof command === "object" && command !== null
      ? { ok: true, command: command as CommandRecord }
      : { ok: false, code: "unknown", status };
  }
  const code = body.error?.code;
  return { ok: false, code: typeof code === "string" ? code : "unknown", status };
}

const MESSAGES: Readonly<Record<string, string>> = {
  request_not_open: "That request is no longer open. It may already be answered.",
  request_expired: "That request expired. The agent moved on in its terminal.",
  not_answerable: "This prompt cannot be answered here. Open the session in your terminal.",
  command_in_flight: "A command for this request is already running.",
  opener_failed: "Could not open the session on this machine.",
  request_session_mismatch: "This request belongs to a different session.",
  idempotency_conflict: "That click clashed with an earlier one. Try again.",
  bad_request: "The engine refused that command. Try again.",
  unknown_request: "The engine does not know this request any more.",
  unknown_session: "The engine does not know this session.",
  unknown_project: "The engine does not know this project.",
  history_context_rejected: "Commands are not available while viewing history.",
  network: "Could not reach the engine. The command may have been sent; try again.",
  timeout: "The engine did not respond in time. The command may have been sent; try again.",
};

/** A short plain sentence for an error code. Never the code itself, never server text. */
export function commandErrorMessage(code: string): string {
  return MESSAGES[code] ?? "Something went wrong. Try again.";
}
