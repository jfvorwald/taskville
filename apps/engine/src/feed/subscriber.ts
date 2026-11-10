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

/**
 * A frame waiting to be written: the ToolCall as of the event with this ingest sequence. One
 * event can give several frames (a boundary closing parallel calls); only the last carries the
 * `id`, so a client that resumes mid-event gets the whole event again (idempotent snapshots).
 */
interface PendingFrame {
  sequence: number;
  call: FeedToolCall;
  last: boolean;
}

const framesOf = (sequence: number, calls: FeedToolCall[]): PendingFrame[] =>
  calls.map((call, i) => ({ sequence, call, last: i === calls.length - 1 }));

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
 *   name and time), so the tracker folds the events that can matter to the agent (its own and its
 *   sessions', see `Storage.agentFeedEvents`) from sequence 1 even when the client resumes later; frames at or below `after` are folded and not sent.
 *   When the agent enters a session that already has events the fold skipped, the fold starts
 *   over on the wider subset and sends only frames it has not sent (`#coverSessions`).
 * - The subset fold runs without retention. When a retention drop of the whole log's fold could
 *   show in this agent's frames (`ToolCallTracker.needsFullFold`), the fold starts over on the
 *   whole log, with retention, for the rest of the feed (`#goFull`), and again sends only frames it
 *   has not sent.
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
  #tracker: ToolCallTracker;
  #lastQueued = 0;
  /** Frames of events at or below this were sent or skipped already (starts at `after`). */
  #quiet: number;
  /**
   * The agent's sessions the fold covers, from the last storage read. A session the agent enters
   * later had its earlier events left out, so entering one sends the fold back to storage.
   */
  #sessions: Map<string, number> | undefined;
  /** The fold met the agent in a session it does not cover: read the sessions again. */
  #recheck = false;
  /** The fold reads the whole log (`#goFull`), not the agent's subset; never switches back. */
  #full = false;
  #phase: "backlog" | "live" = "backlog";
  #queue: PendingFrame[] = [];
  #closed = false;
  #wake: (() => void) | undefined;
  #detach: (() => void) | undefined;
  #finalWrite: Promise<unknown> | undefined;

  constructor(stream: SSEStreamingApi, options: FeedSubscriberOptions) {
    this.#stream = stream;
    this.#options = options;
    this.#quiet = options.after;
    this.#tracker = this.#newTracker();
  }

  /** A subset tracker scoped to the sessions read last, or a full one once `#full`. */
  #newTracker(): ToolCallTracker {
    const { projectId, agentId } = this.#options;
    if (this.#full) return new ToolCallTracker(projectId, agentId);
    return new ToolCallTracker(projectId, agentId, {
      inScope: (sessionId) => this.#sessions?.has(sessionId) === true,
    });
  }

  /**
   * From now on fold the whole log with retention: start over from sequence 1 and send only
   * frames of events above the last one folded (the subset gave the same frames up to it).
   */
  #goFull(): void {
    this.#full = true;
    this.#quiet = Math.max(this.#quiet, this.#lastQueued);
    this.#lastQueued = 0;
    this.#tracker = this.#newTracker();
    this.#phase = "backlog";
  }

  /** Called once when the subscriber closes for any reason (removes it from the hub). */
  onClose(detach: () => void): void {
    this.#detach = detach;
  }

  offer(event: StoredEnvelope): void {
    if (this.#closed || this.#phase === "backlog") return;
    const seq = event.ingestSequence;
    if (seq <= this.#lastQueued) return;
    if (this.#entersSession(event)) {
      this.#recheck = true;
      this.#phase = "backlog";
    } else if (seq > this.#lastQueued + 1) {
      this.#phase = "backlog";
    } else if (this.#tracker.needsFullFold(event)) {
      this.#goFull();
    } else {
      this.#lastQueued = seq;
      const calls = this.#tracker.applyAll(event);
      if (calls.length > 0 && seq > this.#quiet) {
        if (this.#queue.length + calls.length > this.#options.queueLimit) {
          this.#cutOff("slow_consumer");
          return;
        }
        this.#queue.push(...framesOf(seq, calls));
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

  /** Whether the event is the agent's in a session the fold does not cover yet. */
  #entersSession(event: StoredEnvelope): boolean {
    if (this.#full) return false;
    const sessionId = event.sessionId;
    if (event.agentId !== this.#options.agentId || sessionId === undefined) return false;
    return this.#sessions?.has(sessionId) !== true;
  }

  /**
   * Before a read: if the agent has entered a session with events at or below the fold's cursor,
   * those were never folded (the subset did not hold that session then), so the fold starts over
   * from sequence 1 on the current subset and sends only frames of events it has not sent yet.
   */
  #coverSessions(): void {
    if (this.#full) return;
    const previous = this.#sessions;
    if (previous !== undefined && !this.#recheck) return;
    this.#recheck = false;
    const sessions = this.#options.storage.agentSessions(
      this.#options.projectId,
      this.#options.agentId,
    );
    this.#sessions = sessions;
    if (previous === undefined) return;
    for (const [sessionId, first] of sessions) {
      if (previous.has(sessionId) || first > this.#lastQueued) continue;
      this.#quiet = Math.max(this.#quiet, this.#lastQueued);
      this.#lastQueued = 0;
      this.#tracker = this.#newTracker();
      return;
    }
  }

  /** Folds the next page of the log and, if it reached the head, switches to live in the same tick. */
  #readPage(): PendingFrame[] {
    const frames: PendingFrame[] = [];
    let read = 0;
    const head = this.#options.storage.head(this.#options.projectId) ?? 0;
    this.#coverSessions();
    const { storage, projectId, agentId } = this.#options;
    const events = this.#full
      ? storage.events(projectId, this.#lastQueued)
      : storage.agentFeedEvents(projectId, agentId, this.#lastQueued);
    let entered = false;
    for (const event of events) {
      // Committed since the sessions were read (between pages): fold it after the next check.
      if (this.#entersSession(event)) {
        entered = true;
        break;
      }
      if (this.#tracker.needsFullFold(event)) {
        // The frames gathered so far are the full fold's too; the next page starts it over.
        this.#goFull();
        return frames;
      }
      read++;
      this.#lastQueued = event.ingestSequence;
      const calls = this.#tracker.applyAll(event);
      if (calls.length > 0 && event.ingestSequence > this.#quiet) {
        frames.push(...framesOf(event.ingestSequence, calls));
      }
      if (read === BACKLOG_PAGE) break;
    }
    if (entered) this.#recheck = true;
    else if (read < BACKLOG_PAGE) {
      // Other agents' events were not read; the head was read in this tick, so all up to it are folded.
      this.#lastQueued = Math.max(this.#lastQueued, head);
      this.#phase = "live";
    }
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
    return this.#write(
      "toolcall",
      JSON.stringify(data),
      frame.last ? String(frame.sequence) : undefined,
    );
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
