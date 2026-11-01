import { MAX_OPEN_TOOL_CALLS_PER_AGENT } from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import type { SSEStreamingApi } from "hono/streaming";
import { afterEach, describe, expect, it } from "vitest";
import { FeedSubscriber, type FeedSubscriberOptions } from "../../src/feed/subscriber.ts";
import { ToolCallTracker } from "../../src/feed/tool-calls.ts";
import { type Harness, leadOf, runBash, SPIKE_CWD, useHarness } from "./helpers.ts";

// M5.01 review-fix round: the feed's subscriber and tracker, driven directly. A subscriber built
// here is not attached to the hub, so the test decides which events it is offered (and in what
// order) and which only reach it by being read from storage.

const start = useHarness();
const SESSION = "5c4b3a29-1807-4f6e-9d5c-4b3a29180716";
const AGENT = leadOf(SESSION);

interface Written {
  event: string;
  data: string;
  id?: string;
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

async function waitFor(check: () => boolean, ms = 2000): Promise<void> {
  for (let waited = 0; waited < ms && !check(); waited += 10) await sleep(10);
}

const open: FeedSubscriber[] = [];
afterEach(() => {
  for (const subscriber of open.splice(0)) subscriber.abort();
});

interface Opened {
  subscriber: FeedSubscriber;
  writes: Written[];
  /** Starts the run loop (already started unless `autostart` was false). */
  begin(): Promise<void>;
  toolcalls(): { id: string | undefined; data: { toolCallId: string; phase: string } }[];
  heartbeats(): { head: number }[];
}

/** A subscriber on a recording stream, running. `onWrite` sees each message as it is written. */
function openSubscriber(
  h: Harness,
  options: Partial<FeedSubscriberOptions> = {},
  onWrite?: (message: Written) => void,
  autostart = true,
): Opened {
  const writes: Written[] = [];
  const stream = {
    writeSSE: (message: Written) => {
      writes.push(message);
      onWrite?.(message);
      return Promise.resolve();
    },
    write: () => Promise.resolve(),
    abort: () => {},
    onAbort: () => {},
  } as unknown as SSEStreamingApi;
  const subscriber = new FeedSubscriber(stream, {
    storage: h.engine.storage,
    evidence: h.evidence,
    projectId: "spike",
    agentId: AGENT,
    after: 0,
    queueLimit: 1000,
    heartbeatMs: 60_000,
    drainTimeoutMs: 1000,
    ...options,
  });
  open.push(subscriber);
  let running: Promise<void> | undefined;
  const begin = () => {
    running ??= subscriber.run();
    return running;
  };
  if (autostart) begin();
  return {
    subscriber,
    writes,
    begin,
    toolcalls: () =>
      writes
        .filter((w) => w.event === "toolcall")
        .map((w) => ({ id: w.id, data: JSON.parse(w.data) })),
    heartbeats: () => writes.filter((w) => w.event === "heartbeat").map((w) => JSON.parse(w.data)),
  };
}

const pre = (toolUseId: string) => ({
  session_id: SESSION,
  cwd: SPIKE_CWD,
  permission_mode: "default",
  tool_name: "Bash",
  tool_input: { command: `echo ${toolUseId}`, description: toolUseId },
  tool_use_id: toolUseId,
  hook_event_name: "PreToolUse",
});

describe("FeedSubscriber heartbeat", () => {
  // Contract: the heartbeat after the backlog is "not sent at all if the stream already ended".
  // Pass now. Mutation: drop `&& !this.#closed` from the catch-up heartbeat.
  it("sends no catch-up heartbeat when the stream ended while the backlog was being written", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await runBash(h, {
      session: SESSION,
      toolUseId: "toolu_hb1",
      command: "x",
      stdout: "x\n",
      label: "hb1",
    });

    let subscriber: FeedSubscriber | undefined;
    const opened = openSubscriber(
      h,
      {},
      (message) => {
        // The client goes away while the first frame is in flight.
        if (message.event === "toolcall") subscriber?.abort();
      },
      false,
    );
    subscriber = opened.subscriber;
    await opened.begin();
    expect(opened.toolcalls()).toHaveLength(1);
    expect(opened.heartbeats()).toEqual([]);
  });

  // The idle heartbeat compares the head with what was folded: a broadcast the subscriber never
  // saw must send it back to storage, and the frames behind it must not be lost.
  // Pass now. Mutation: drop `if (head > this.#lastQueued) this.#phase = "backlog"`.
  it("goes back to the backlog at a heartbeat when the project head is ahead of what it folded", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    await runBash(h, {
      session: SESSION,
      toolUseId: "toolu_hb2a",
      command: "a",
      stdout: "a\n",
      label: "hb2a",
    });
    const opened = openSubscriber(h, { heartbeatMs: 40 });
    await waitFor(() => opened.heartbeats().length >= 1);
    expect(opened.toolcalls().map((f) => f.data.phase)).toEqual(["running", "succeeded"]);

    // Recorded in storage; this subscriber is not on the hub, so it is never offered these events.
    await h.hook(pre("toolu_hb2b"), "hb2b#pre");
    const head = h.engine.storage.head("spike") ?? 0;

    await waitFor(() => opened.toolcalls().length >= 3);
    const frames = opened.toolcalls().filter((f) => f.data.toolCallId === "toolu_hb2b");
    expect(frames.map((f) => f.data.phase)).toEqual(["running"]);
    await sleep(120);
    expect(opened.toolcalls().filter((f) => f.data.toolCallId === "toolu_hb2b")).toHaveLength(1);
    // The heartbeats that follow carry the new head.
    await waitFor(() => opened.heartbeats().at(-1)?.head === head);
    expect(opened.heartbeats().at(-1)).toEqual({ head });
  });
});

describe("FeedSubscriber.offer: duplicates and gaps", () => {
  /** A subscriber live on a project that holds one finished call; returns what was recorded after. */
  async function liveWithCalls(h: Harness, calls: string[]) {
    h.addProject("spike", SPIKE_CWD);
    await runBash(h, {
      session: SESSION,
      toolUseId: "toolu_base",
      command: "b",
      stdout: "b\n",
      label: "base",
    });
    const opened = openSubscriber(h);
    await waitFor(() => opened.heartbeats().length >= 1);
    expect(opened.toolcalls()).toHaveLength(2);
    const head = h.engine.storage.head("spike") ?? 0;
    for (const call of calls) await h.hook(pre(call), `${call}#pre`);
    const later = h.events("spike").filter((e) => e.ingestSequence > head);
    return { opened, later };
  }

  const startOf = (events: StoredEnvelope[], toolCallId: string): StoredEnvelope => {
    const found = events.find(
      (e) =>
        e.type === "tool_call.started" &&
        (e.payload as { toolCallId: string }).toolCallId === toolCallId,
    );
    if (found === undefined) throw new Error(`no start for ${toolCallId}`);
    return found;
  };

  // Pass now. Mutation: drop `if (seq <= this.#lastQueued) return`.
  it("drops an event whose sequence it already folded: no second frame, whatever the repeat says", async () => {
    const h = await start();
    const { opened, later } = await liveWithCalls(h, ["toolu_dup"]);
    for (const event of later) opened.subscriber.offer(event);
    await waitFor(() => opened.toolcalls().length >= 3);
    expect(opened.toolcalls().filter((f) => f.data.toolCallId === "toolu_dup")).toHaveLength(1);

    const real = startOf(later, "toolu_dup");
    const last = later.at(-1) as StoredEnvelope;
    // The same event again, then forged starts that reuse sequences already folded (the highest
    // one, and an older one): a tracker alone would take a forged start as a new call.
    opened.subscriber.offer(real);
    for (const sequence of [last.ingestSequence, real.ingestSequence]) {
      opened.subscriber.offer({
        ...real,
        ingestSequence: sequence,
        payload: { toolCallId: `toolu_forged_${sequence}`, toolName: "Bash" },
      } as StoredEnvelope);
    }
    await sleep(120);
    const ids = opened.toolcalls().map((f) => f.data.toolCallId);
    expect(ids.filter((id) => id === "toolu_dup")).toHaveLength(1);
    expect(ids.filter((id) => id.startsWith("toolu_forged"))).toEqual([]);
  });

  // Pass now. Mutation: drop the `seq > this.#lastQueued + 1` branch that returns to the backlog.
  it("goes back to storage when a sequence is skipped, and the missing frame still arrives once, in order", async () => {
    const h = await start();
    const { opened, later } = await liveWithCalls(h, ["toolu_gap_b", "toolu_gap_c"]);
    const skipped = startOf(later, "toolu_gap_b");
    for (const event of later) {
      if (event !== skipped) opened.subscriber.offer(event);
    }
    await waitFor(
      () => opened.toolcalls().filter((f) => f.data.toolCallId.startsWith("toolu_gap")).length >= 2,
    );
    await sleep(120);
    const gap = opened.toolcalls().filter((f) => f.data.toolCallId.startsWith("toolu_gap"));
    expect(gap.map((f) => [f.data.toolCallId, f.data.phase])).toEqual([
      ["toolu_gap_b", "running"],
      ["toolu_gap_c", "running"],
    ]);
    const ids = gap.map((f) => Number(f.id));
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });
});

// --- ToolCallTracker, synthetic events (the reducer needs no registration to track a call) ---

let seq = 0;
function envelope(
  type: string,
  payload: Record<string, unknown>,
  agentId = "tracked",
): StoredEnvelope {
  seq += 1;
  return {
    schemaVersion: 1,
    projectId: "p",
    sourceId: "adapter:test",
    sourceEventId: `ev-${seq}`,
    occurredAt: new Date(Date.parse("2026-10-31T10:00:00.000Z") + seq * 1000).toISOString(),
    agentId,
    sessionId: "tracked-session",
    type,
    payload,
    provenance: "live",
    evidenceIds: [],
    late: false,
    eventId: `00000000-0000-4000-8000-${String(seq).padStart(12, "0")}`,
    receivedAt: "2026-10-31T10:00:00.000Z",
    ingestSequence: seq,
  } as unknown as StoredEnvelope;
}

/** The accessor the review round asks for (name pinned by these tests): open calls the tracker still tracks. */
const openCallCount = (tracker: ToolCallTracker): number | undefined =>
  (tracker as unknown as { openCallCount?: () => number }).openCallCount?.();

describe("ToolCallTracker is bounded by what the reducer holds (security review M2)", () => {
  // Fail now: the tracker's open set grows with every call that never finishes, one entry per
  // call for the life of a feed. The domain reducer drops the oldest open call of an agent beyond
  // MAX_OPEN_TOOL_CALLS_PER_AGENT, and the tracker must stop tracking what the reducer dropped.
  // New API: `ToolCallTracker.openCallCount(): number` (read-only; calls currently tracked as open).
  it("tracks no more open calls than the reducer keeps for the agent, however many start and never finish", () => {
    const tracker = new ToolCallTracker("p", "tracked");
    const total = MAX_OPEN_TOOL_CALLS_PER_AGENT + 40;
    for (let i = 0; i < total; i++) {
      const frame = tracker.apply(
        envelope("tool_call.started", { toolCallId: `open-${i}`, toolName: "Bash" }),
      );
      // The feed still serves a frame for every call, including those the reducer drops.
      expect(frame?.toolCallId).toBe(`open-${i}`);
      expect(frame?.phase).toBe("running");
    }
    expect(openCallCount(tracker)).toBe(MAX_OPEN_TOOL_CALLS_PER_AGENT);
  });

  it("closes the call the reducer closes at a turn end, and then tracks none", () => {
    const tracker = new ToolCallTracker("p", "tracked");
    const total = MAX_OPEN_TOOL_CALLS_PER_AGENT + 5;
    for (let i = 0; i < total; i++) {
      tracker.apply(envelope("tool_call.started", { toolCallId: `turn-${i}`, toolName: "Bash" }));
    }
    const closed = tracker.apply(envelope("session.turn_ended", {}));
    expect(closed?.phase).toBe("unfinished");
    expect(closed?.toolCallId).toBe(`turn-${total - 1}`);
    expect(openCallCount(tracker)).toBe(0);
  });
});

describe("ToolCallTracker restores a repeated start the reducer holds again (review fix 65c61e3)", () => {
  // Pass now. Mutation: drop the `else { this.#restoreRepeatedStart(event); }` branch in apply().
  // The reducer drops the oldest open call beyond its cap; a second start for that toolCallId (new
  // source event) is a new call to the reducer, which holds it running again. The tracker sends no
  // frame for the repeat, but its open set must track the call again, or the turn end closes it
  // in the reducer without the feed ever announcing it.
  it("sends the unfinished frame at a turn end for a call that was dropped and then started again", () => {
    const tracker = new ToolCallTracker("p", "tracked");
    for (let i = 0; i <= MAX_OPEN_TOOL_CALLS_PER_AGENT; i++) {
      tracker.apply(envelope("tool_call.started", { toolCallId: `again-${i}`, toolName: "Bash" }));
    }
    // again-0 is the oldest of MAX + 1 open calls: the reducer dropped it, the tracker forgot it.
    expect(openCallCount(tracker)).toBe(MAX_OPEN_TOOL_CALLS_PER_AGENT);

    const repeat = tracker.apply(
      envelope("tool_call.started", { toolCallId: "again-0", toolName: "Bash" }),
    );
    expect(repeat).toBeUndefined(); // a repeated start sends no frame
    expect(openCallCount(tracker)).toBe(MAX_OPEN_TOOL_CALLS_PER_AGENT);

    const closed = tracker.apply(envelope("session.turn_ended", {}));
    expect(closed?.toolCallId).toBe("again-0");
    expect(closed?.phase).toBe("unfinished");
    expect(openCallCount(tracker)).toBe(0);
  });
});
