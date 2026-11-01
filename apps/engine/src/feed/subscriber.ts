import type { ResnapshotReason, StoredEnvelope } from "@taskville/protocol";
import type { SSEStreamingApi } from "hono/streaming";
import type { EvidenceStore } from "../evidence/index.ts";
import type { Storage } from "../storage/index.ts";
import type { HubSubscriber } from "../stream/index.ts";
import { type FrameEvidence, frameEvidence } from "./evidence.ts";
import { type FeedToolCall, ToolCallTracker } from "./tool-calls.ts";

/** Events read from storage per page, so a long backlog never sits in memory at once. */
const BACKLOG_PAGE = 256;

/** `data` of an `event: toolcall` frame (contracts/http-api.md). */
export type ToolCallFrame = FeedToolCall & { evidence: FrameEvidence };

export interface FeedSubscriberOptions {
  storage: Storage;
  evidence: EvidenceStore;
  projectId: string;
  agentId: string;
  /** Last ingest sequence the client already has. */
  after: number;
  queueLimit: number;
  heartbeatMs: number;
  /** A write the client has not taken after this long ends the stream. */
  drainTimeoutMs: number;
}

/** A frame waiting to be written: the ToolCall as of the event with this ingest sequence. */
interface PendingFrame {
  sequence: number;
  call: FeedToolCall;
}

/**
 * One write, raced against the drain timeout: a client that never reads would otherwise hold its
 * socket and its stream slot forever (security review L1). On expiry the stream aborts and this
 * returns false.
 */
export async function writeWithin(
  stream: SSEStreamingApi,
  message: { event: string; data: string; id?: string },
  drainTimeoutMs: number,
): Promise<boolean> {
  const write = stream.writeSSE(message);
  write.catch(() => {});
  let timer: NodeJS.Timeout | undefined;
  const expired = new Promise<"expired">((resolve) => {
    timer = setTimeout(() => resolve("expired"), drainTimeoutMs);
  });
  try {
    if ((await Promise.race([write, expired])) === "expired") {
      stream.abort();
      return false;
    }
    return true;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One open agent feed (contracts/http-api.md). Like the project stream's subscriber it sends the
 * backlog from storage and then live events from the hub with no gap and no duplicate, but it
 * turns the agent's `tool_call.*` events into ToolCall frames:
 *
 * - A ToolCall's state at an event depends on the events before it (a finish carries the start's
 *   name and time), so the tracker folds the project's log from sequence 1 even when the client
 *   resumes later; frames at or below `after` are folded and not sent.
 * - `lastQueued` is the highest project sequence folded. A live event at or below it is a
 *   duplicate and dropped; one above `lastQueued + 1` means a broadcast was missed, so the
 *   subscriber goes back to reading storage.
 * - Frames wait in a queue of at most `queueLimit`; overflow cuts the stream off with
 *   `resnapshot` / `slow_consumer`. Evidence references are read at write time, not queue time:
 *   the Claude Code source stores a hook's bodies right after its events commit.
 */
export class FeedSubscriber implements HubSubscriber {
  readonly #options: FeedSubscriberOptions;
  readonly #stream: SSEStreamingApi;
  readonly #tracker: ToolCallTracker;
  #lastQueued = 0;
  #phase: "backlog" | "live" = "backlog";
  #queue: PendingFrame[] = [];
  #closed = false;
  #wake: (() => void) | undefined;
  #detach: (() => void) | undefined;
  #finalWrite: Promise<unknown> | undefined;

  constructor(stream: SSEStreamingApi, options: FeedSubscriberOptions) {
    this.#stream = stream;
    this.#options = options;
    this.#tracker = new ToolCallTracker(options.agentId);
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
    } else {
      this.#lastQueued = seq;
      const call = this.#tracker.apply(event);
      if (call !== undefined && seq > this.#options.after) {
        if (this.#queue.length >= this.#options.queueLimit) {
          this.#cutOff("slow_consumer");
          return;
        }
        this.#queue.push({ sequence: seq, call });
      }
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
        await this.#writeFrame(next);
        continue;
      }
      if (this.#phase === "backlog") {
        for (const frame of this.#readPage()) {
          if (this.#closed) break;
          await this.#writeFrame(frame);
        }
        // Folding a long log sends nothing; give the event loop a turn between pages.
        await new Promise<void>((resolve) => setImmediate(resolve));
        if (this.#isLive() && !this.#closed) {
          // Caught up: say so, with the head, so the client knows the backlog is complete.
          await this.#write("heartbeat", JSON.stringify({ head: this.#lastQueued }));
        }
        continue;
      }
      if ((await this.#idle()) === "heartbeat" && !this.#closed) {
        const head = this.#options.storage.head(this.#options.projectId) ?? 0;
        if (head > this.#lastQueued) this.#phase = "backlog";
        await this.#write("heartbeat", JSON.stringify({ head }));
      }
    }
  }

  /** Whether reading storage has reached the head (`#readPage` and `offer` change the phase). */
  #isLive(): boolean {
    return this.#phase === "live";
  }

  /** Folds the next page of the log and, if it reached the head, switches to live in the same tick. */
  #readPage(): PendingFrame[] {
    const frames: PendingFrame[] = [];
    let read = 0;
    for (const event of this.#options.storage.events(this.#options.projectId, this.#lastQueued)) {
      read++;
      this.#lastQueued = event.ingestSequence;
      const call = this.#tracker.apply(event);
      if (call !== undefined && event.ingestSequence > this.#options.after) {
        frames.push({ sequence: event.ingestSequence, call });
      }
      if (read === BACKLOG_PAGE) break;
    }
    if (read < BACKLOG_PAGE) this.#phase = "live";
    return frames;
  }

  #writeFrame(frame: PendingFrame): Promise<void> {
    const data: ToolCallFrame = {
      ...frame.call,
      evidence: frameEvidence(
        this.#options.evidence,
        this.#options.projectId,
        frame.call.toolCallId,
        frame.call.phase,
      ),
    };
    return this.#write("toolcall", JSON.stringify(data), String(frame.sequence));
  }

  async #write(event: string, data: string, id?: string): Promise<void> {
    const written = await writeWithin(
      this.#stream,
      id === undefined ? { event, data } : { event, data, id },
      this.#options.drainTimeoutMs,
    );
    if (!written) this.abort();
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
    // `write` hands the frame to the stream writer synchronously (unlike `writeSSE`, which awaits
    // first), so it is queued behind any frame in flight. No `close()` here: Hono skips aborting
    // on client cancel once a stream is marked closed, so the route lets streamSSE close after
    // `drained()`, and a disconnect while the frame waits still aborts the pending writes.
    this.#finalWrite = this.#stream.write(
      `event: resnapshot\ndata: ${JSON.stringify({ reason })}\n\n`,
    );
    // A client that never reads would hold its socket forever (security review F5): abort after a
    // bounded wait, which also settles the writes blocked on it.
    const timer = setTimeout(() => this.#stream.abort(), this.#options.drainTimeoutMs);
    timer.unref();
    void this.#finalWrite.finally(() => clearTimeout(timer));
  }
}
