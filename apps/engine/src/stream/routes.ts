import { type ProjectState, projectStateHash, replay } from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import {
  type ProjectsResponse,
  type SnapshotResponse,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_SUBSCRIBER_QUEUE_LIMIT,
} from "@taskville/protocol";
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import type { PairingStore } from "../auth/pairing.ts";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import { domainReducer } from "../ingest/index.ts";
import type { Storage } from "../storage/index.ts";
import type { StreamHub } from "./hub.ts";
import { StreamSubscriber } from "./subscriber.ts";

/** Most SSE streams served at once; more get 503 (security review F5). */
export const MAX_SSE_STREAMS = 64;
/** How long a cut-off stream may wait for its client to take the resnapshot frame. */
export const CUTOFF_DRAIN_TIMEOUT_MS = 5000;

export interface StreamRouteOptions {
  storage: Storage;
  hub: StreamHub;
  /** Revoking pairings ends every stream authenticated by a browser session (security review F1). */
  pairing: PairingStore;
  /** Engine clock for snapshot `computedAt` and attention. */
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

const unknownProject = (c: Context<AppEnv>) =>
  apiError(c, 404, "unknown_project", "No project with this ID");

/**
 * Read routes (contracts/http-api.md): project list, snapshot, and the
 * resumable SSE stream. Registered on the app from `createApp`, so the Host,
 * Origin, and credential middleware already ran; the `read` scope admits the
 * CLI token and a paired browser session, never the bridge token.
 */
export function registerStreamRoutes(app: Hono<AppEnv>, options: StreamRouteOptions): void {
  const { storage, hub } = options;
  const now = options.now ?? (() => new Date());
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const queueLimit = options.queueLimit ?? SSE_SUBSCRIBER_QUEUE_LIMIT;
  const maxStreams = options.maxStreams ?? MAX_SSE_STREAMS;
  const drainTimeoutMs = options.drainTimeoutMs ?? CUTOFF_DRAIN_TIMEOUT_MS;

  app.get("/v1/projects", requireScope("read"), (c) => {
    const body: ProjectsResponse = {
      projects: storage.projects().map(({ id, name, roots, builtin, head }) => ({
        id,
        name,
        roots,
        builtin,
        head,
      })),
    };
    return c.json(body);
  });

  app.get("/v1/projects/:id/snapshot", requireScope("read"), (c) => {
    const projectId = c.req.param("id");
    // One transaction, so the state and its cursor come from the same commit.
    const read = storage.transaction((tx) => {
      const head = tx.head(projectId);
      if (head === undefined) return undefined;
      const stored = tx.projection<ProjectState>(projectId);
      if (stored && stored.reducerVersion === domainReducer.version && stored.head === head) {
        return {
          head,
          reducerVersion: stored.reducerVersion,
          stateHash: stored.stateHash,
          state: stored.state,
        };
      }
      // No projection yet (or a stale one): answer from a replay without writing.
      const state = replay(projectId, tx.events(projectId));
      return {
        head,
        reducerVersion: state.reducerVersion,
        stateHash: projectStateHash(state),
        state,
      };
    });
    if (read === undefined) return unknownProject(c);
    // Attention depends on the clock, so it is computed here and is not part of stateHash.
    const at = now();
    const body: SnapshotResponse = {
      projectId,
      cursor: read.head,
      reducerVersion: read.reducerVersion,
      stateHash: read.stateHash,
      state: read.state as unknown as Record<string, unknown>,
      attention: attention(read.state, at.getTime()),
      computedAt: at.toISOString(),
    };
    return c.json(body);
  });

  app.get("/v1/projects/:id/events", requireScope("read"), (c) => {
    const projectId = c.req.param("id");
    const after = readCursor(c);
    if (after === undefined) {
      return apiError(c, 400, "bad_request", "Cursor must be a non-negative integer");
    }
    if (storage.head(projectId) === undefined) return unknownProject(c);
    // Checked and tracked in the same tick (streamSSE runs the callback up to its
    // first await synchronously), so concurrent requests cannot overshoot the cap.
    if (hub.openStreams() >= maxStreams) {
      return apiError(c, 503, "too_many_streams", "Too many open event streams");
    }
    const bySession = c.get("credential") === "session";

    return streamSSE(c, async (stream) => {
      // Tracked until the transport finishes, so shutdown can abort any stream,
      // including one cut off whose client never read its last frame.
      const untrack = hub.track(() => stream.abort());
      stream.onAbort(untrack);
      // A session's grant ends with `taskville unpair`, so its open stream does too.
      const unwatch = bySession ? options.pairing.onRevoke(() => stream.abort()) : () => {};
      stream.onAbort(unwatch);
      try {
        const head = storage.head(projectId) ?? 0;
        if (after > head) {
          await stream.writeSSE({
            event: "resnapshot",
            data: JSON.stringify({ reason: "cursor_ahead_of_head" }),
          });
          return;
        }
        const subscriber = new StreamSubscriber(stream, {
          storage,
          projectId,
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
}
