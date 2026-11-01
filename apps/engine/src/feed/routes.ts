import { SSE_HEARTBEAT_INTERVAL_MS, SSE_SUBSCRIBER_QUEUE_LIMIT } from "@taskville/protocol";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { PairingStore } from "../auth/pairing.ts";
import type { EvidenceStore } from "../evidence/index.ts";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import type { Storage } from "../storage/index.ts";
import { CUTOFF_DRAIN_TIMEOUT_MS, MAX_SSE_STREAMS, type StreamHub } from "../stream/index.ts";
import { resolveAgentProject } from "./agents.ts";
import { buildCrew } from "./crew.ts";
import { registerEvidenceRoute } from "./evidence.ts";
import { FeedSubscriber, writeWithin } from "./subscriber.ts";

export interface FeedRouteOptions {
  storage: Storage;
  /** The engine's hub: feeds count against its stream cap and end when it closes. */
  hub: StreamHub;
  /** Revoking pairings ends every feed authenticated by a browser session. */
  pairing: PairingStore;
  evidence: EvidenceStore;
  /** Engine clock: `elapsedMs` of a running crew member is `now - startedAt`. */
  now?: () => Date;
  heartbeatMs?: number;
  queueLimit?: number;
  maxStreams?: number;
  drainTimeoutMs?: number;
}

const CURSOR = /^(0|[1-9][0-9]{0,15})$/;

/** A cursor from `Last-Event-ID` (which wins) or `?after=`; 0 when neither is sent; undefined if malformed. */
function readCursor(c: Context<AppEnv>): number | undefined {
  const raw = c.req.header("last-event-id") ?? c.req.query("after") ?? "0";
  if (!CURSOR.test(raw)) return undefined;
  const value = Number(raw);
  return Number.isSafeInteger(value) ? value : undefined;
}

/**
 * Agent feed, crew and evidence routes (contracts/http-api.md): the ToolCalls of one agent as a
 * resumable SSE stream, the family of one agent, and the stored body of a tool call. Registered on
 * the app from `createApp`, so the Host, Origin, and credential middleware already ran; the
 * `read` scope admits the CLI token and a paired browser session, never the bridge token.
 */
export function registerFeedRoutes(app: Hono<AppEnv>, options: FeedRouteOptions): void {
  const { storage, hub, evidence } = options;
  const now = options.now ?? (() => new Date());
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const queueLimit = options.queueLimit ?? SSE_SUBSCRIBER_QUEUE_LIMIT;
  const maxStreams = options.maxStreams ?? MAX_SSE_STREAMS;
  const drainTimeoutMs = options.drainTimeoutMs ?? CUTOFF_DRAIN_TIMEOUT_MS;

  app.get("/v1/agents/:id/feed", requireScope("read"), (c) => {
    const after = readCursor(c);
    if (after === undefined) {
      return apiError(c, 400, "bad_request", "Cursor must be a non-negative integer");
    }
    const agentId = c.req.param("id");
    const projectId = resolveAgentProject(c, storage, agentId);
    if (projectId instanceof Response) return projectId;
    // Checked and tracked in the same tick (streamSSE runs the callback up to its first await
    // synchronously), so concurrent requests cannot overshoot the cap.
    if (hub.openStreams() >= maxStreams) {
      return apiError(c, 503, "too_many_streams", "Too many open event streams");
    }
    const bySession = c.get("credential") === "session";

    return streamSSE(c, async (stream) => {
      const untrack = hub.track(() => stream.abort());
      stream.onAbort(untrack);
      // A session's grant ends with `taskville unpair`, so its open feed does too.
      const unwatch = bySession ? options.pairing.onRevoke(() => stream.abort()) : () => {};
      stream.onAbort(unwatch);
      try {
        const head = storage.head(projectId) ?? 0;
        if (after > head) {
          await writeWithin(
            stream,
            { event: "resnapshot", data: JSON.stringify({ reason: "cursor_ahead_of_head" }) },
            drainTimeoutMs,
          );
          return;
        }
        const subscriber = new FeedSubscriber(stream, {
          storage,
          evidence,
          projectId,
          agentId,
          after,
          queueLimit,
          heartbeatMs,
          drainTimeoutMs,
        });
        subscriber.onClose(hub.subscribe(projectId, subscriber));
        stream.onAbort(() => subscriber.abort());
        try {
          await subscriber.run();
          await subscriber.drained();
        } finally {
          subscriber.abort();
        }
      } finally {
        unwatch();
        untrack();
      }
    });
  });

  app.get("/v1/agents/:id/crew", requireScope("read"), (c) => {
    const agentId = c.req.param("id");
    const projectId = resolveAgentProject(c, storage, agentId);
    if (projectId instanceof Response) return projectId;
    return c.json(buildCrew(storage, projectId, agentId, now()));
  });

  registerEvidenceRoute(app, evidence);
}
