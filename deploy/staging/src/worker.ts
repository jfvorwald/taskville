// The taskville-staging Worker (M7.03, S-3 option C): the frozen web client from the release,
// plus a small read-only `/v1` backed by one seeded demo run. It reaches nothing: no database, no
// permission bridge, no agent, no proxy, no outbound fetch (the Access key lookup in access.ts is
// the single exception). Commands and held requests get synthetic answers.

import {
  type ApiErrorCode,
  COMMAND_TYPES,
  idSchema,
  pairingRequestSchema,
  pairingResponseSchema,
} from "@taskville/protocol";
import { realAccessVerifier } from "./access.ts";
import {
  attentionSnapshotFrame,
  demoHead,
  eventFrames,
  isDemoProject,
  parsePosition,
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
const CURSOR = /^(0|[1-9][0-9]{0,15})$/;
const startedAt = Date.now();

type ErrorCode = ApiErrorCode | "request_expired";

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

function pairingStub(env: Env): DurableObjectStubLike {
  return env.PAIRING.get(env.PAIRING.idFromName("pairing") as never);
}

function callStore(env: Env, path: string, body: unknown): Promise<Response> {
  return pairingStub(env).fetch(
    new Request(`https://pairing.internal${path}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    }),
  );
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

function heartbeatOfHead(): SseMessage {
  return { event: "heartbeat", data: JSON.stringify({ head: demoHead() }) };
}

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
  const text = await request.text();
  if (text.length > MAX_PAIRING_BODY) return failure(413, "payload_too_large", "Body too large");
  const parsed = pairingRequestSchema.safeParse(
    (() => {
      try {
        return JSON.parse(text);
      } catch {
        return undefined;
      }
    })(),
  );
  if (!parsed.success) return failure(400, "bad_request", "Expected { code: string }");
  const redeemed = await callStore(env, "/redeem", { code: parsed.data.code });
  if (!redeemed.ok) {
    return failure(401, "invalid_pairing_code", "Pairing code is invalid, used, or expired");
  }
  return answer(pairingResponseSchema.parse(await redeemed.json()));
}

async function hasSession(request: Request, env: Env): Promise<Response | undefined> {
  const session = request.headers.get(SESSION_HEADER);
  if (session === null) return failure(401, "unauthorized", "Credentials required");
  const checked = await callStore(env, "/check", { session });
  return checked.ok ? undefined : failure(401, "unauthorized", "Unknown or revoked session");
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

/** A synthetic outcome for a command: nothing is delivered, because nothing is connected. */
async function command(request: Request): Promise<Response> {
  const text = await request.text();
  if (text.length > MAX_COMMAND_BODY) {
    return failure(413, "payload_too_large", "Command body is too large");
  }
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    body = undefined;
  }
  const fields = (typeof body === "object" && body !== null ? body : {}) as Record<string, unknown>;
  const type = COMMAND_TYPES.find((candidate) => candidate === fields.type);
  const names =
    type === "session.open"
      ? ["projectId", "requestId", "idempotencyKey", "sessionId"]
      : ["projectId", "requestId", "idempotencyKey"];
  if (type === undefined || !names.every((name) => idSchema.safeParse(fields[name]).success)) {
    return failure(400, "bad_request", "Not a command this site understands");
  }
  return answer({
    command: {
      // Derived from the key, so a retry of the same command gets the same answer.
      id: `staging-${String(fields.idempotencyKey)}`,
      type,
      requestId: String(fields.requestId),
      status: "unsupported",
    },
  });
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
    handle: (_r, _e, _u, m) =>
      isDemoProject(decoded(m[1])) ? answer(snapshotBody()) : unknownProject(),
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/timelines$/,
    handle: (_r, _e, _u, m) =>
      isDemoProject(decoded(m[1])) ? answer(timelinesBody(decoded(m[1]))) : unknownProject(),
  },
  {
    method: "GET",
    pattern: /^\/v1\/projects\/([^/]+)\/events$/,
    handle: (request, _e, url, m) => {
      const after = readCursor(request, url);
      if (after === undefined) {
        return failure(400, "bad_request", "Cursor must be a non-negative integer");
      }
      if (!isDemoProject(decoded(m[1]))) return unknownProject();
      const frames = eventFrames(after);
      if (frames === undefined) return sseResponse([RESNAPSHOT]);
      return sseResponse(frames, { heartbeat: heartbeatOfHead });
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
      if (after > demoHead()) return sseResponse([RESNAPSHOT]);
      return sseResponse([heartbeatOfHead()], { heartbeat: heartbeatOfHead });
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
        projectId: "demo",
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
];

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
      return env.ASSETS.fetch(request);
    },
  };
}

export default createWorker({ verifyAccess: realAccessVerifier });
