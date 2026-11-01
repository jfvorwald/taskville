import { type ProjectState, replay } from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import {
  type Attention,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_SUBSCRIBER_QUEUE_LIMIT,
} from "@taskville/protocol";
import type { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { Logger } from "pino";
import type { PairingStore } from "../auth/pairing.ts";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import type { CommittedBatch } from "../ingest/index.ts";
import { domainReducer } from "../ingest/index.ts";
import type { Storage } from "../storage/index.ts";
import type { StreamHub } from "./hub.ts";
import { CUTOFF_DRAIN_TIMEOUT_MS } from "./routes.ts";

/** How often the feed recomputes attention against the clock, for silence that no event announces. */
export const ATTENTION_TICK_MS = 30_000;

/** One project's `needs_you` and `trouble` records (never `waiting`). Empty means cleared. */
export interface ProjectAttention {
  projectId: string;
  name: string;
  attention: Attention[];
}

export type AttentionFrame =
  | { event: "snapshot"; data: { projects: ProjectAttention[]; computedAt: string } }
  | { event: "attention"; data: ProjectAttention & { computedAt: string } };

/** What `AttentionFeed` hands to one open stream. */
export interface AttentionListener {
  /** A frame to send, in order. Must not throw or block. */
  offer(frame: AttentionFrame): void;
}

export interface AttentionFeedOptions {
  storage: Storage;
  /** Engine clock for `computedAt` and the silence rule. */
  now?: () => Date;
  tickMs?: number;
  /** Where a storage failure is reported (the error name only). */
  logger?: Logger;
}

/**
 * The part of a record that makes it a different record; its reason text changes every tick and
 * does not. JSON keeps the fields apart whatever characters the opaque IDs hold.
 */
const recordKey = (r: Attention): string =>
  JSON.stringify([r.agentId, r.level, r.kind, r.requestId ?? null]);

/** One project's record keys in a fixed order, so a reorder of the same set compares equal. */
const keysOf = (records: readonly Attention[]): string[] => records.map(recordKey).sort();

const sameKeys = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((key, i) => key === b[i]);

/**
 * The global attention feed (ARCHITECTURE.md 2.8 and 10): which projects have an agent that needs
 * you or is in trouble. One instance per engine. It remembers the last set it announced for each
 * project and tells its listeners only when a set changes, whether a commit or the timer found it.
 * While nobody listens it does no work; a new listener recomputes every project first, so its
 * snapshot and the change frames after it agree. A storage failure is logged and skipped: the
 * feed keeps running and the next commit or tick tries again.
 */
export class AttentionFeed {
  readonly #storage: Storage;
  readonly #now: () => Date;
  readonly #logger: Logger | undefined;
  readonly #listeners = new Set<AttentionListener>();
  /** Last announced name, sorted record keys and records per project that has any. */
  readonly #announced = new Map<string, { name: string; keys: string[]; records: Attention[] }>();
  readonly #timer: NodeJS.Timeout;

  constructor(options: AttentionFeedOptions) {
    this.#storage = options.storage;
    this.#now = options.now ?? (() => new Date());
    this.#logger = options.logger;
    this.#timer = setInterval(() => {
      if (this.#listeners.size > 0) this.#refreshAll(this.#names(), this.#now());
    }, options.tickMs ?? ATTENTION_TICK_MS);
    this.#timer.unref();
  }

  /** The ingest pipeline's `onCommit`, bound: recomputes the projects the batch wrote to. */
  readonly publish = (batch: CommittedBatch): void => {
    if (this.#listeners.size === 0) return;
    const names = this.#names();
    if (names === undefined) return;
    const at = this.#now();
    for (const projectId of Object.keys(batch.heads)) this.#refresh(projectId, names, at);
  };

  /** Registers a listener and gives it the snapshot as its first frame. Returns unsubscribe. */
  subscribe(listener: AttentionListener): () => void {
    const names = this.#names();
    const at = this.#now();
    this.#refreshAll(names, at);
    const projects: ProjectAttention[] = [];
    for (const projectId of [...this.#announced.keys()].sort()) {
      const known = this.#announced.get(projectId);
      if (known === undefined) continue;
      // A failed read falls back to the last announced set: the unchanged set is never announced
      // again, so a snapshot that left the project out would hide it from this client for good.
      projects.push({
        projectId,
        name: names?.get(projectId) ?? known.name,
        attention: this.#tryCompute(projectId, at) ?? known.records,
      });
    }
    listener.offer({ event: "snapshot", data: { projects, computedAt: at.toISOString() } });
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }

  close(): void {
    clearInterval(this.#timer);
    this.#listeners.clear();
  }

  /** Every project's name, or undefined when storage failed (nothing is concluded from that). */
  #names(): Map<string, string> | undefined {
    try {
      return new Map(this.#storage.projects().map((p) => [p.id, p.name]));
    } catch (error) {
      this.#logger?.error({ errName: (error as Error).name }, "attention projects unreadable");
      return undefined;
    }
  }

  #refreshAll(names: Map<string, string> | undefined, at: Date): void {
    if (names === undefined) return;
    for (const projectId of names.keys()) this.#refresh(projectId, names, at);
    // A project that left storage while it had attention is cleared, then forgotten.
    for (const projectId of [...this.#announced.keys()]) {
      if (!names.has(projectId)) this.#refresh(projectId, names, at);
    }
  }

  #refresh(projectId: string, names: Map<string, string>, at: Date): void {
    const known = this.#announced.get(projectId);
    const name = names.get(projectId);
    if (name === undefined && known === undefined) return;
    const records = name === undefined ? [] : this.#tryCompute(projectId, at);
    if (records === undefined) return;
    const keys = keysOf(records);
    if (sameKeys(keys, known?.keys ?? [])) return;
    const shownName = name ?? known?.name ?? projectId;
    if (keys.length === 0) this.#announced.delete(projectId);
    else this.#announced.set(projectId, { name: shownName, keys, records });
    const frame: AttentionFrame = {
      event: "attention",
      data: { projectId, name: shownName, attention: records, computedAt: at.toISOString() },
    };
    for (const listener of [...this.#listeners]) listener.offer(frame);
  }

  /** The project's records, or undefined (logged) when storage or replay failed. */
  #tryCompute(projectId: string, at: Date): Attention[] | undefined {
    try {
      return this.#compute(projectId, at);
    } catch (error) {
      this.#logger?.error({ errName: (error as Error).name }, "attention unreadable");
      return undefined;
    }
  }

  #compute(projectId: string, at: Date): Attention[] {
    const stored = this.#storage.projection<ProjectState>(projectId);
    const head = this.#storage.head(projectId);
    const state =
      stored && stored.reducerVersion === domainReducer.version && stored.head === head
        ? stored.state
        : replay(projectId, this.#storage.events(projectId));
    return attention(state, at.getTime()).filter((r) => r.level !== "waiting");
  }
}

export interface AttentionSubscriberOptions {
  queueLimit: number;
  heartbeatMs: number;
  /** A write the client has not taken after this long ends the stream. */
  drainTimeoutMs: number;
}

/**
 * One open attention stream. Frames wait in a queue of at most `queueLimit`; a client that stops
 * reading overflows it and the stream ends, and its reconnect starts with a fresh snapshot (the
 * feed has no ids and no resume, so there is nothing to catch up on).
 */
export class AttentionSubscriber implements AttentionListener {
  readonly #stream: SSEStreamingApi;
  readonly #options: AttentionSubscriberOptions;
  #queue: AttentionFrame[] = [];
  #closed = false;
  #wake: (() => void) | undefined;

  constructor(stream: SSEStreamingApi, options: AttentionSubscriberOptions) {
    this.#stream = stream;
    this.#options = options;
  }

  offer(frame: AttentionFrame): void {
    if (this.#closed) return;
    if (this.#queue.length >= this.#options.queueLimit) {
      this.abort();
      this.#stream.abort();
      return;
    }
    this.#queue.push(frame);
    this.#wake?.();
  }

  /** Client disconnected or the engine is shutting down. */
  abort(): void {
    this.#closed = true;
    this.#queue = [];
    this.#wake?.();
  }

  /** Writes frames until the stream closes. */
  async run(): Promise<void> {
    while (!this.#closed) {
      const next = this.#queue.shift();
      if (next) {
        await this.#write(next.event, JSON.stringify(next.data));
        continue;
      }
      if ((await this.#idle()) === "heartbeat" && !this.#closed) {
        await this.#write("heartbeat", "{}");
      }
    }
  }

  /**
   * One write, raced against the drain timeout: a client that never reads would otherwise hold
   * its socket and its stream slot forever (security review L1). On expiry the stream aborts.
   */
  async #write(event: string, data: string): Promise<void> {
    const write = this.#stream.writeSSE({ event, data });
    write.catch(() => {});
    let timer: NodeJS.Timeout | undefined;
    const expired = new Promise<"expired">((resolve) => {
      timer = setTimeout(() => resolve("expired"), this.#options.drainTimeoutMs);
    });
    try {
      if ((await Promise.race([write, expired])) === "expired") {
        this.abort();
        this.#stream.abort();
      }
    } finally {
      clearTimeout(timer);
    }
  }

  #idle(): Promise<"wake" | "heartbeat"> {
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.#wake = undefined;
        resolve("heartbeat");
      }, this.#options.heartbeatMs);
      this.#wake = () => {
        clearTimeout(timer);
        this.#wake = undefined;
        resolve("wake");
      };
    });
  }
}

export interface AttentionRouteOptions {
  feed: AttentionFeed;
  hub: StreamHub;
  /** Revoking pairings ends every stream authenticated by a browser session. */
  pairing: PairingStore;
  heartbeatMs?: number;
  queueLimit?: number;
  /** Default `CUTOFF_DRAIN_TIMEOUT_MS`, as for the project streams. */
  drainTimeoutMs?: number;
  maxStreams: number;
}

/**
 * `GET /v1/attention/events` (contracts/http-api.md): the SSE feed of every project's
 * `needs_you` and `trouble` attention. Same grant as the other read routes (CLI token or a paired
 * browser session, never the bridge token), the same stream cap, and the same end on unpair.
 */
export function registerAttentionRoute(app: Hono<AppEnv>, options: AttentionRouteOptions): void {
  const { feed, hub, maxStreams } = options;
  const heartbeatMs = options.heartbeatMs ?? SSE_HEARTBEAT_INTERVAL_MS;
  const queueLimit = options.queueLimit ?? SSE_SUBSCRIBER_QUEUE_LIMIT;
  const drainTimeoutMs = options.drainTimeoutMs ?? CUTOFF_DRAIN_TIMEOUT_MS;

  app.get("/v1/attention/events", requireScope("read"), (c) => {
    // Checked and tracked in the same tick, as for the project streams, so the cap cannot be overshot.
    if (hub.openStreams() >= maxStreams) {
      return apiError(c, 503, "too_many_streams", "Too many open event streams");
    }
    const bySession = c.get("credential") === "session";

    return streamSSE(c, async (stream) => {
      const untrack = hub.track(() => stream.abort());
      stream.onAbort(untrack);
      const unwatch = bySession ? options.pairing.onRevoke(() => stream.abort()) : () => {};
      stream.onAbort(unwatch);
      const subscriber = new AttentionSubscriber(stream, {
        queueLimit,
        heartbeatMs,
        drainTimeoutMs,
      });
      const unsubscribe = feed.subscribe(subscriber);
      stream.onAbort(() => subscriber.abort());
      try {
        await subscriber.run();
      } finally {
        subscriber.abort();
        unsubscribe();
        unwatch();
        untrack();
      }
    });
  });
}
