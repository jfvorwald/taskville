import type { StoredEnvelope } from "@taskville/protocol";
import type { CommittedBatch } from "../ingest/index.ts";

/** One open stream, as the hub sees it. */
export interface HubSubscriber {
  /** A committed event of the subscriber's project, in ingest order. Must not throw or block. */
  offer(event: StoredEnvelope): void;
  /** The engine is shutting down: end the stream now. */
  end(): void;
}

/**
 * Fans committed batches out to open SSE streams. `publish` is the ingest
 * pipeline's `onCommit`, so it only ever sees committed events. The hub keeps
 * no history: a subscriber that misses something reads it back from storage.
 */
export class StreamHub {
  readonly #subscribers = new Map<string, Set<HubSubscriber>>();
  /** Every open stream until its transport finishes, including ones already cut off and draining. */
  readonly #open = new Set<() => void>();

  /** Bound, so it can be passed as `onCommit` directly. */
  readonly publish = (batch: CommittedBatch): void => {
    for (const event of batch.events) {
      const set = this.#subscribers.get(event.projectId);
      if (!set) continue;
      for (const subscriber of [...set]) subscriber.offer(event);
    }
  };

  subscribe(projectId: string, subscriber: HubSubscriber): () => void {
    let set = this.#subscribers.get(projectId);
    if (!set) {
      set = new Set();
      this.#subscribers.set(projectId, set);
    }
    set.add(subscriber);
    return () => {
      const current = this.#subscribers.get(projectId);
      current?.delete(subscriber);
      if (current?.size === 0) this.#subscribers.delete(projectId);
    };
  }

  subscriberCount(projectId?: string): number {
    if (projectId !== undefined) return this.#subscribers.get(projectId)?.size ?? 0;
    let total = 0;
    for (const set of this.#subscribers.values()) total += set.size;
    return total;
  }

  /**
   * Tracks an open stream so shutdown can abort it, even after it left the
   * fan-out (a cut-off stream still draining its last frame). Returns untrack.
   */
  track(abort: () => void): () => void {
    this.#open.add(abort);
    return () => {
      this.#open.delete(abort);
    };
  }

  openStreams(): number {
    return this.#open.size;
  }

  /** Ends every open stream (engine shutdown), so the HTTP server can close. */
  close(): void {
    for (const set of [...this.#subscribers.values()]) {
      for (const subscriber of [...set]) subscriber.end();
    }
    this.#subscribers.clear();
    for (const abort of [...this.#open]) abort();
    this.#open.clear();
  }
}
