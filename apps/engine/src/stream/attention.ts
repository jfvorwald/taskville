import { type ProjectState, replay } from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import {
  type Attention,
  SSE_HEARTBEAT_INTERVAL_MS,
  SSE_SUBSCRIBER_QUEUE_LIMIT,
} from "@taskville/protocol";
import type { Hono } from "hono";
import { type SSEStreamingApi, streamSSE } from "hono/streaming";
import type { PairingStore } from "../auth/pairing.ts";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import type { CommittedBatch } from "../ingest/index.ts";
import { domainReducer } from "../ingest/index.ts";
import type { Storage } from "../storage/index.ts";
import type { StreamHub } from "./hub.ts";

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
}

/** The part of a record that makes it a different record; its reason text changes every tick and does not. */
const recordKey = (r: Attention): string =>
  `${r.agentId}\u0000${r.level}\u0000${r.kind}\u0000${r.requestId ?? ""}`;

/**
 * The global attention feed (ARCHITECTURE.md 2.8 and 10): which projects have an agent that needs
 * you or is in trouble. One instance per engine. It remembers the last set it announced for each
 * project and tells its listeners only when a set changes, whether a commit or the timer found it.
 * While nobody listens it does no work; a new listener recomputes every project first, so its
 * snapshot and the change frames after it agree.
 */
export class AttentionFeed {
  readonly #storage: Storage;
  readonly #now: () => Date;
  readonly #listeners = new Set<AttentionListener>();
  /** Last announced record keys per project that has any. */
  readonly #announced = new Map<string, string>();
  readonly #timer: NodeJS.Timeout;

  constructor(options: AttentionFeedOptions) {
    this.#storage = options.storage;
    this.#now = options.now ?? (() => new Date());
    this.#timer = setInterval(() => {
      if (this.#listeners.size > 0) this.#refreshAll();
    }, options.tickMs ?? ATTENTION_TICK_MS);
    this.#timer.unref();
  }

  /** The ingest pipeline's `onCommit`, bound: recomputes the projects the batch wrote to. */
  readonly publish = (batch: CommittedBatch): void => {
    if (this.#listeners.size === 0) return;
    const names = this.#names();
    const at = this.#now();
    for (const projectId of Object.keys(batch.heads)) this.#refresh(projectId, names, at);
  };

  /** Registers a listener and gives it the snapshot as its first frame. Returns unsubscribe. */
  subscribe(listener: AttentionListener): () => void {
    this.#refreshAll();
    const names = this.#names();
    const at = this.#now();
    const projects: ProjectAttention[] = [];
    for (const projectId of [...this.#announced.keys()].sort()) {
      const name = names.get(projectId);
      if (name === undefined) continue;
      projects.push({ projectId, name, attention: this.#compute(projectId, at) });
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

  #names(): Map<string, string> {
    return new Map(this.#storage.projects().map((p) => [p.id, p.name]));
  }

  #refreshAll(): void {
    const names = this.#names();
    const at = this.#now();
    for (const projectId of names.keys()) this.#refresh(projectId, names, at);
  }

  #refresh(projectId: string, names: Map<string, string>, at: Date): void {
    const name = names.get(projectId);
    if (name === undefined) return;
    const records = this.#compute(projectId, at);
    const key = records.map(recordKey).join("\u0001");
    if (key === (this.#announced.get(projectId) ?? "")) return;
    if (key === "") this.#announced.delete(projectId);
    else this.#announced.set(projectId, key);
    const frame: AttentionFrame = {
      event: "attention",
      data: { projectId, name, attention: records, computedAt: at.toISOString() },
    };
    for (const listener of [...this.#listeners]) listener.offer(frame);
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
        await this.#stream.writeSSE({ event: next.event, data: JSON.stringify(next.data) });
        continue;
      }
      if ((await this.#idle()) === "heartbeat" && !this.#closed) {
        await this.#stream.writeSSE({ event: "heartbeat", data: "{}" });
      }
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
      const subscriber = new AttentionSubscriber(stream, { queueLimit, heartbeatMs });
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
