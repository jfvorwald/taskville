import type { ResnapshotReason, StoredEnvelope } from "@taskville/protocol";
import type { SSEStreamingApi } from "hono/streaming";
import type { Storage } from "../storage/index.ts";
import type { HubSubscriber } from "./hub.ts";

/** Backlog events read from storage per page, so a long backlog never sits in memory at once. */
const BACKLOG_PAGE = 256;

export interface SubscriberOptions {
  storage: Storage;
  projectId: string;
  /** Last ingest sequence the client already has. */
  after: number;
  queueLimit: number;
  heartbeatMs: number;
}

/**
 * One SSE connection (contracts/http-api.md). Sends the backlog `after+1..head`
 * from storage, then live events from the hub, with no gaps and no duplicates:
 *
 * - `lastQueued` is the highest sequence already read from storage or queued.
 *   A live event at or below it is a duplicate and dropped; one above
 *   `lastQueued + 1` means a broadcast was missed (another connection
 *   committed, or the process failed between COMMIT and publish), so the
 *   subscriber goes back to reading storage from `lastQueued`.
 * - Storage reads and hub offers run synchronously on one thread, and ingest
 *   publishes only after COMMIT, so a page read and the switch to live
 *   happen with no commit in between.
 * - Live frames wait in a queue of at most `queueLimit`. Hono's writes have no
 *   cap, so a client that stops reading fills the queue and is cut off with
 *   `resnapshot` / `slow_consumer`; nothing else is affected.
 * - When idle, a heartbeat carries the current head; a head beyond
 *   `lastQueued` also sends the subscriber back to storage.
 */
export class StreamSubscriber implements HubSubscriber {
  readonly #options: SubscriberOptions;
  readonly #stream: SSEStreamingApi;
  #lastQueued: number;
  #phase: "backlog" | "live" = "backlog";
  #queue: StoredEnvelope[] = [];
  #closed = false;
  #wake: (() => void) | undefined;
  #detach: (() => void) | undefined;
  #finalWrite: Promise<unknown> | undefined;

  constructor(stream: SSEStreamingApi, options: SubscriberOptions) {
    this.#stream = stream;
    this.#options = options;
    this.#lastQueued = options.after;
  }

  /** Called once when the subscriber closes for any reason (removes it from the hub). */
  onClose(detach: () => void): void {
    this.#detach = detach;
  }

  offer(event: StoredEnvelope): void {
    if (this.#closed || this.#phase === "backlog") return;
    const seq = event.ingestSequence;
    if (seq <= this.#lastQueued) return;
    if (seq > this.#lastQueued + 1) {
      this.#phase = "backlog";
    } else if (this.#queue.length >= this.#options.queueLimit) {
      this.#cutOff("slow_consumer");
      return;
    } else {
      this.#queue.push(event);
      this.#lastQueued = seq;
    }
    this.#wake?.();
  }

  end(): void {
    if (this.#closed) return;
    this.#close();
    // Shutdown: drop whatever the client has not read, so its connection ends now.
    this.#stream.abort();
  }

  /** Client disconnected. */
  abort(): void {
    if (!this.#closed) this.#close();
  }

  /** Resolves once a final `resnapshot` frame was taken by the client, or the stream was aborted. */
  drained(): Promise<unknown> {
    return this.#finalWrite ?? Promise.resolve();
  }

  /** Writes frames until the stream closes. */
  async run(): Promise<void> {
    while (!this.#closed) {
      const next = this.#queue.shift();
      if (next) {
        await this.#writeEvent(next);
        continue;
      }
      if (this.#phase === "backlog") {
        for (const event of this.#readPage()) {
          if (this.#closed) break;
          await this.#writeEvent(event);
        }
        continue;
      }
      if ((await this.#idle()) === "heartbeat" && !this.#closed) {
        const head = this.#options.storage.head(this.#options.projectId) ?? 0;
        if (head > this.#lastQueued) this.#phase = "backlog";
        await this.#stream.writeSSE({ event: "heartbeat", data: JSON.stringify({ head }) });
      }
    }
  }

  /** Reads the next backlog page and, if it reached the head, switches to live in the same tick. */
  #readPage(): StoredEnvelope[] {
    const page: StoredEnvelope[] = [];
    for (const event of this.#options.storage.events(this.#options.projectId, this.#lastQueued)) {
      page.push(event);
      if (page.length === BACKLOG_PAGE) break;
    }
    const last = page.at(-1);
    if (last) this.#lastQueued = last.ingestSequence;
    if (page.length < BACKLOG_PAGE) this.#phase = "live";
    return page;
  }

  #writeEvent(event: StoredEnvelope): Promise<void> {
    return this.#stream.writeSSE({
      event: "event",
      id: String(event.ingestSequence),
      data: JSON.stringify(event),
    });
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

  #close(): void {
    this.#closed = true;
    this.#queue = [];
    this.#detach?.();
    this.#detach = undefined;
    this.#wake?.();
  }

  #cutOff(reason: ResnapshotReason): void {
    this.#close();
    // `write` hands the frame to the stream writer synchronously (unlike `writeSSE`,
    // which awaits first), so it is queued behind any frame in flight. No `close()`
    // here: Hono skips aborting on client cancel once a stream is marked closed, so
    // the route lets streamSSE close after `drained()`, and a disconnect while the
    // frame waits still aborts the pending writes.
    this.#finalWrite = this.#stream.write(
      `event: resnapshot\ndata: ${JSON.stringify({ reason })}\n\n`,
    );
  }
}
