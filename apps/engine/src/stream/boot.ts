import type { Hono } from "hono";
import type { Logger } from "pino";
import type { PairingStore } from "../auth/pairing.ts";
import type { AppEnv } from "../http/app.ts";
import { domainReducer, IngestPipeline, registerIngestRoute } from "../ingest/index.ts";
import {
  ensureUnsortedProject,
  openStorage,
  rebuildStaleProjections,
  type Storage,
} from "../storage/index.ts";
import { ATTENTION_TICK_MS, AttentionFeed, registerAttentionRoute } from "./attention.ts";
import { type ExpiredRequest, expireOpenRequests } from "./expire.ts";
import { StreamHub } from "./hub.ts";
import { CUTOFF_DRAIN_TIMEOUT_MS, MAX_SSE_STREAMS, registerStreamRoutes } from "./routes.ts";

export interface BootOptions {
  /** The app from `createApp`, so every route gets its security middleware. */
  app: Hono<AppEnv>;
  /** `$TASKVILLE_HOME/taskville.db` (config `homePaths(home).db`). */
  dbPath: string;
  /** The same PairingStore passed to `createApp`, so `unpair` ends browser streams. */
  pairing: PairingStore;
  now?: () => Date;
  logger?: Logger;
  heartbeatMs?: number;
  /** How often the global attention feed recomputes against the clock (default 30000). */
  attentionTickMs?: number;
  queueLimit?: number;
  maxStreams?: number;
  drainTimeoutMs?: number;
}

export interface Engine {
  storage: Storage;
  hub: StreamHub;
  pipeline: IngestPipeline;
  /** Projects whose projection was rebuilt at boot (missing or another reducer version). */
  rebuilt: string[];
  /** Requests that were still open and got `request.expired` at this boot. */
  expired: ExpiredRequest[];
  queueLimit: number;
  maxStreams: number;
  drainTimeoutMs: number;
  attentionTickMs: number;
  /** For `createApp({ health })`: database readable and in WAL mode. */
  health(): { db: "ok" | "error"; walMode: boolean };
  /** Ends every open stream, then closes the database. Call before closing the HTTP server. */
  close(): void;
}

/**
 * Engine composition for `taskville serve` (#16), run before the server
 * listens: open storage (owner-only files, WAL, migrations), make sure the
 * built-in Unsorted project exists, rebuild every stale projection from the
 * event log, expire every request still open (its hook connection died with
 * the old process), then register ingest and the read and stream routes on `app`,
 * with ingest broadcasting to the stream hub only after COMMIT.
 */
export function bootEngine(options: BootOptions): Engine {
  const now = options.now ?? (() => new Date());
  const storage = openStorage(options.dbPath, { now });
  let closed = false;
  try {
    ensureUnsortedProject(storage, { now });
    const rebuilt = rebuildStaleProjections(storage, domainReducer);
    if (rebuilt.length > 0) options.logger?.info({ rebuilt }, "projections rebuilt");
    const expired = expireOpenRequests(storage, domainReducer, { now });
    if (expired.length > 0)
      options.logger?.info({ count: expired.length }, "open requests expired");
    const hub = new StreamHub();
    const attentionTickMs = options.attentionTickMs ?? ATTENTION_TICK_MS;
    const attentionFeed = new AttentionFeed({ storage, now, tickMs: attentionTickMs });
    const pipeline = new IngestPipeline({
      storage,
      now,
      onCommit: (batch) => {
        hub.publish(batch);
        attentionFeed.publish(batch);
      },
      ...(options.logger ? { logger: options.logger } : {}),
    });
    const queueLimit = options.queueLimit ?? 1000;
    const maxStreams = options.maxStreams ?? MAX_SSE_STREAMS;
    const drainTimeoutMs = options.drainTimeoutMs ?? CUTOFF_DRAIN_TIMEOUT_MS;
    registerIngestRoute(options.app, pipeline);
    registerStreamRoutes(options.app, {
      storage,
      hub,
      pairing: options.pairing,
      now,
      queueLimit,
      maxStreams,
      drainTimeoutMs,
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    });
    registerAttentionRoute(options.app, {
      feed: attentionFeed,
      hub,
      pairing: options.pairing,
      maxStreams,
      queueLimit,
      ...(options.heartbeatMs === undefined ? {} : { heartbeatMs: options.heartbeatMs }),
    });
    return {
      storage,
      hub,
      pipeline,
      rebuilt,
      expired,
      queueLimit,
      maxStreams,
      drainTimeoutMs,
      attentionTickMs,
      health: () => {
        if (closed) return { db: "error", walMode: false };
        try {
          const wal = storage.journalMode() === "wal";
          return { db: "ok", walMode: wal };
        } catch {
          return { db: "error", walMode: false };
        }
      },
      close: () => {
        if (closed) return;
        closed = true;
        attentionFeed.close();
        hub.close();
        storage.close();
      },
    };
  } catch (error) {
    storage.close();
    throw error;
  }
}
