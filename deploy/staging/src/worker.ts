// The taskville-staging Worker (M7.03, S-3 option C): the frozen web client from the release,
// plus a small read-only `/v1` backed by one seeded demo run. It reaches nothing: no database, no
// permission bridge, no agent, no proxy, no outbound fetch (the Access key lookup in access.ts is
// the single exception). Commands and held requests are refused the way the engine refuses a
// request it no longer holds.

import {
  type ApiErrorCode,
  COMMAND_TYPES,
  idSchema,
  pairingRequestSchema,
  pairingResponseSchema,
  pairingRevokeResponseSchema,
} from "@taskville/protocol";
import { realAccessVerifier } from "./access.ts";
import {
  attentionSnapshotFrame,
  DEMO_PROJECT_ID,
  eventFrames,
  isKnownProject,
  parsePosition,
  projectHead,
  projectsBody,
  snapshotBody,
  timelineEvents,
  timelineState,
  timelinesBody,
} from "./demo.ts";
import type { DurableObjectStubLike, Env, VerifyAccess } from "./env.ts";
import { PairingStore } from "./pairing-store.ts";
import { type SseMessage, sseResponse } from "./sse.ts";

export type { Env, VerifyAccess };
export { PairingStore };

const ACCESS_HEADER = "cf-access-jwt-assertion";
const SESSION_HEADER = "x-taskville-session";
const MAX_PAIRING_BODY = 1024;
const MAX_COMMAND_BODY = 16 * 1024;
const MAX_DENY_MESSAGE_CHARS = 1000;
const CURSOR = /^(0|[1-9][0-9]{0,15})$/;
/** What the store hands out: 32 random bytes as unpadded base64url. */
const PAIRING_CODE = /^[A-Za-z0-9_-]{43}$/;
const startedAt = Date.now();

/**
 * The engine's page policy (`PAGE_CSP` in apps/engine/src/http/static.ts), which cannot be
 * imported here because that module reads files. A test compares the two strings.
 */
const PAGE_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "media-src 'self' blob:",
  "worker-src 'self' blob:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'self'",
  "frame-ancestors 'none'",
].join("; ");

type ErrorCode = ApiErrorCode | "request_expired" | "history_context_rejected";

function failure(status: number, code: ErrorCode, message: string): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "cache-control": "no-store" } },
  );
}

function answer(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

const notFound = () => failure(404, "not_found", "Not found");
const tooLarge = () => failure(413, "payload_too_large", "Body too large");

function callStore(env: Env, path: string, body: unknown): Promise<Response> {
  const stub: DurableObjectStubLike = env.PAIRING.get(env.PAIRING.idFromName("pairing") as never);
  return stub.fetch(
    new Request(`https://pairing.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
}

/**
 * The body as text, or undefined when it is over `max`. A declared length over the cap is refused
 * without touching the body; an undeclared one is read only as far as the cap.
 */
async function readBody(request: Request, max: number): Promise<string | undefined> {
  const declared = request.headers.get("content-length");
  if (declared !== null && Number(declared) > max) return undefined;
  if (request.body === null) return "";
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > max) {
      await reader.cancel();
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(bytes);
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

/** A path segment, decoded; left as sent when it is not valid percent-encoding. */
function decoded(segment: string | undefined): string {
  const raw = segment ?? "";
  try {
    return decodeURIComponent(raw);
  } catch {
    return raw;
  }
}

/** A cursor from `Last-Event-ID` (which wins) or `?after=`; undefined if malformed. */
function readCursor(request: Request, url: URL): number | undefined {
  const raw = request.headers.get("last-event-id") ?? url.searchParams.get("after") ?? "0";
  if (!CURSOR.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

const heartbeatOf = (projectId: string) => (): SseMessage => ({
  event: "heartbeat",
  data: JSON.stringify({ head: projectHead(projectId) }),
});

const RESNAPSHOT: SseMessage = {
  event: "resnapshot",
  data: JSON.stringify({ reason: "cursor_ahead_of_head" }),
};

/** The engine's rule for browser requests: an Origin, when sent, is this site's; a POST sends one. */
function originRefusal(request: Request, url: URL): Response | undefined {
  const origin = request.headers.get("origin");
  if (origin !== null && origin.toLowerCase() !== url.origin) {
    return failure(403, "forbidden_origin", "Origin is not allowed");
  }
  if (request.method === "POST" && origin === null) {
    return failure(403, "forbidden_origin", "Origin header required");
  }
  return undefined;
}

async function pair(request: Request, env: Env, verifyAccess: VerifyAccess): Promise<Response> {
  const jwt = request.headers.get(ACCESS_HEADER);
  const refused = () => failure(403, "credential_not_allowed", "Sign in through Access first");
  if (jwt === null || jwt === "") return refused();
  let identity: Awaited<ReturnType<VerifyAccess>>;
  try {
    identity = await verifyAccess(jwt, env);
  } catch {
    identity = null;
  }
  if (identity === null) return refused();
  const allowed = env.ACCESS_ALLOWED_EMAIL?.trim();
  if (allowed && identity.email.toLowerCase() !== allowed.toLowerCase()) return refused();
  const minted = await callStore(env, "/mint", { identity: identity.email });
  if (!minted.ok) return failure(500, "internal", "Internal error");
  const { code } = (await minted.json()) as { code: string };
  return new Response(null, {
    status: 302,
    headers: {
      location: `${new URL(request.url).origin}/#pair=${encodeURIComponent(code)}`,
      "cache-control": "no-store",
    },
  });
}

async function exchange(request: Request, env: Env): Promise<Response> {
  const text = await readBody(request, MAX_PAIRING_BODY);
  if (text === undefined) return tooLarge();
  const parsed = pairingRequestSchema.safeParse(parseJson(text));
  if (!parsed.success) return failure(400, "bad_request", "Expected { code: string }");
  const invalid = () =>
    failure(401, "invalid_pairing_code", "Pairing code is invalid, used, or expired");
  // A code the store could not have minted is refused here, without a Durable Object call.
  if (!PAIRING_CODE.test(parsed.data.code)) return invalid();
  const redeemed = await callStore(env, "/redeem", { code: parsed.data.code });
  if (!redeemed.ok) return invalid();
  return answer(pairingResponseSchema.parse(await redeemed.json()));
}

async function hasSession(request: Request, env: Env): Promise<Response | undefined> {
  const session = request.headers.get(SESSION_HEADER);
  if (session === null) return failure(401, "unauthorized", "Credentials required");
  const checked = await callStore(env, "/check", { session });
  return checked.ok ? undefined : failure(401, "unauthorized", "Unknown or revoked session");
}

async function revoke(request: Request, env: Env): Promise<Response> {
  const session = request.headers.get(SESSION_HEADER) ?? "";
  const revoked = await callStore(env, "/revoke", { session });
  return answer(pairingRevokeResponseSchema.parse(await revoked.json()));
}

function health(env: Env): Response {
  return answer({
    status: "ok",
    uptimeSeconds: Math.floor((Date.now() - startedAt) / 1000),
    version: env.RELEASE_VERSION,
    release: { id: env.RELEASE_ID, version: env.RELEASE_VERSION, environment: env.APP_ENV },
  });
}

const unknownProject = () => failure(404, "unknown_project", "No project with this ID");

// Commands: validated as strictly as the engine's schema (apps/engine/src/commands/schema.ts),
// then refused as the engine refuses a request it no longer holds: nothing is connected here, so
// no request is ever open to answer.

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const hasOnly = (value: Record<string, unknown>, keys: readonly string[]): boolean =>
  Object.keys(value).every((key) => keys.includes(key));

function validDecision(value: unknown): boolean {
  if (!isRecord(value)) return false;
  if (value.behavior === "allow") return hasOnly(value, ["behavior"]);
  if (value.behavior !== "deny" || !hasOnly(value, ["behavior", "message"])) return false;
  return (
    value.message === undefined ||
    (typeof value.message === "string" && value.message.length <= MAX_DENY_MESSAGE_CHARS)
  );
}

/** The project and context mode of a valid command body, or undefined when it is not one. */
function parseCommand(body: unknown): { projectId: string; mode: string | undefined } | undefined {
  if (!isRecord(body)) return undefined;
  const type = COMMAND_TYPES.find((candidate) => candidate === body.type);
  if (type === undefined) return undefined;
  const common = ["type", "projectId", "requestId", "idempotencyKey", "context"];
  const own = type === "permission.decide" ? "decision" : "sessionId";
  if (!hasOnly(body, [...common, own])) return undefined;
  const ids = ["projectId", "requestId", "idempotencyKey", ...(own === "sessionId" ? [own] : [])];
  if (!ids.every((name) => idSchema.safeParse(body[name]).success)) return undefined;
  if (type === "permission.decide" && !validDecision(body.decision)) return undefined;
  let mode: string | undefined;
  if (body.context !== undefined) {
    const { context } = body;
    if (!isRecord(context) || !hasOnly(context, ["mode"])) return undefined;
    if (context.mode !== "live" && context.mode !== "history") return undefined;
    mode = context.mode;
  }
  return { projectId: String(body.projectId), mode };
}

async function command(request: Request): Promise<Response> {
  const text = await readBody(request, MAX_COMMAND_BODY);
  if (text === undefined) return tooLarge();
  const parsed = parseCommand(parseJson(text));
  if (parsed === undefined) return failure(400, "bad_request", "The command body is not valid");
  if (parsed.mode === "history") {
    return failure(400, "history_context_rejected", "Commands are not accepted from history");
  }
  if (!isKnownProject(parsed.projectId)) return failure(404, "unknown_project", "No such project");
  return failure(410, "request_expired", "The request can no longer be answered here");
}

type Handler = (
  request: Request,
  env: Env,
  url: URL,
  match: RegExpExecArray,
) => Response | Promise<Response>;

const ROUTES: readonly { method: string; pattern: RegExp; handle: Handler }[] = [
  { method: "GET", pattern: /^\/health$/, handle: (_r, env) => health(env) },
  { method: "GET", pattern: /^\/v1\/projects$/, handle: () => answer(projectsBody()) },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/snapshot$/,
    handle: (_r, _e, _u, m) => {
      const snapshot = snapshotBody(decoded(m[1]));
      return snapshot === undefined ? unknownProject() : answer(snapshot);
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/timelines$/,
    handle: (_r, _e, _u, m) =>
      isKnownProject(decoded(m[1])) ? answer(timelinesBody(decoded(m[1]))) : unknownProject(),
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/events$/,
    handle: (request, _e, url, m) => {
      const after = readCursor(request, url);
      if (after === undefined) {
        return failure(400, "bad_request", "Cursor must be a non-negative integer");
      }
      const projectId = decoded(m[1]);
      if (!isKnownProject(projectId)) return unknownProject();
      const frames = eventFrames(projectId, after);
      if (frames === undefined) return sseResponse([RESNAPSHOT]);
      return sseResponse(frames, { heartbeat: heartbeatOf(projectId) });
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/attention\/events$/,
    handle: () =>
      sseResponse([attentionSnapshotFrame()], {
        heartbeat: () => ({ event: "heartbeat", data: "{}" }),
      }),
  },
  {
    // The agent feed carries tool calls, which the engine derives from its own log; staging
    // answers with an open, empty feed.
    method: "GET",
    pattern: /^\/v1\/agents\/([^/]+)\/feed$/,
    handle: (request, _e, url) => {
      const after = readCursor(request, url);
      if (after === undefined) {
        return failure(400, "bad_request", "Cursor must be a non-negative integer");
      }
      if (after > projectHead(DEMO_PROJECT_ID)) return sseResponse([RESNAPSHOT]);
      const heartbeat = heartbeatOf(DEMO_PROJECT_ID);
      return sseResponse([heartbeat()], { heartbeat });
    },
  },
  {
    // No telemetry reaches staging, so no agent has a cost: the engine's answer for that.
    method: "GET",
    pattern: /^\/v1\/agents\/([^/]+)\/cost$/,
    handle: () =>
      Response.json(
        { error: { code: "no_cost", message: "No telemetry reported cost for this agent" } },
        { status: 404, headers: { "cache-control": "no-store" } },
      ),
  },
  {
    method: "GET",
    pattern: /^\/v1\/timelines\/([^/]+)\/events$/,
    handle: (_r, _e, url, m) => {
      const page = timelineEvents(decoded(m[1]), url.searchParams);
      return "error" in page ? failure(400, "bad_request", page.error) : answer(page.body);
    },
  },
  {
    method: "GET",
    pattern: /^\/v1\/timelines\/([^/]+)\/state$/,
    handle: (_r, _e, url, m) => {
      const raw = url.searchParams.get("at");
      const at = raw === null ? undefined : parsePosition(raw);
      if (!at) {
        return failure(
          400,
          "bad_request",
          "at must be an ingest sequence or a zoned ISO 8601 timestamp",
        );
      }
      return answer(timelineState(decoded(m[1]), at));
    },
  },
  {
    // Staging stores no tool call bodies: an evidence id answers with an empty body.
    method: "GET",
    pattern: /^\/v1\/evidence\/([^/]+)$/,
    handle: (_r, _e, _u, m) =>
      answer({
        id: decoded(m[1]),
        projectId: DEMO_PROJECT_ID,
        toolCallId: "",
        part: "input",
        text: "",
        masks: [],
        truncated: false,
        bytes: 0,
      }),
  },
  {
    // There is no permission bridge, so no request is ever held.
    method: "GET",
    pattern: /^\/v1\/requests\/([^/]+)\/input$/,
    handle: (_r, _e, url) =>
      (url.searchParams.get("projectId") ?? "") === ""
        ? failure(400, "bad_request", "Expected a projectId query parameter")
        : failure(410, "request_expired", "The request can no longer be answered here"),
  },
  { method: "POST", pattern: /^\/v1\/commands$/, handle: (request) => command(request) },
  {
    method: "POST",
    pattern: /^\/v1\/pairing\/revoke$/,
    handle: (request, env) => revoke(request, env),
  },
];

/** The release's files, with the engine's page policy on HTML and nosniff on everything. */
async function asset(request: Request, env: Env): Promise<Response> {
  const upstream = await env.ASSETS.fetch(request);
  const headers = new Headers(upstream.headers);
  headers.set("x-content-type-options", "nosniff");
  if ((headers.get("content-type") ?? "").toLowerCase().startsWith("text/html")) {
    headers.set("content-security-policy", PAGE_CSP);
  }
  return new Response(upstream.body, {
    status: upstream.status,
    statusText: upstream.statusText,
    headers,
  });
}

export interface WorkerOptions {
  verifyAccess: VerifyAccess;
}

export function createWorker({ verifyAccess }: WorkerOptions) {
  return {
    async fetch(request: Request, env: Env): Promise<Response> {
      const url = new URL(request.url);
      const path = url.pathname;

      if (path === "/pair") {
        return request.method === "GET" ? pair(request, env, verifyAccess) : notFound();
      }
      if (path === "/v1/pairing" && request.method === "POST") {
        return originRefusal(request, url) ?? (await exchange(request, env));
      }
      if (path === "/health" || path === "/v1" || path.startsWith("/v1/")) {
        const denied = await hasSession(request, env);
        if (denied !== undefined) return denied;
        const refused = originRefusal(request, url);
        if (refused !== undefined) return refused;
        for (const route of ROUTES) {
          if (route.method !== request.method) continue;
          const match = route.pattern.exec(path);
          if (match !== null) return route.handle(request, env, url, match);
        }
        return notFound();
      }
      return asset(request, env);
    },
  };
}

export default createWorker({ verifyAccess: realAccessVerifier });
