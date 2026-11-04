import { describe, expect, it } from "vitest";
import type { SseReader } from "../stream/helpers.ts";
import { ingestRaw, SPIKE_CWD, type ToolCallFrame, useHarness } from "./helpers.ts";

// M5.15 (#285): one boundary event closes every running call of an agent, and the feed must show
// each as `unfinished`. Frame scheme decided by the lead: one `toolcall` frame per closed call;
// only the LAST frame of the event carries `id: <ingestSequence>`, earlier frames of the same event
// carry no `id`. A client that reconnects mid-event with `?after=<previous id>` gets the whole
// event's frames again (frames are full snapshots keyed by toolCallId, so a replay is idempotent);
// one that reconnects after the event's id gets none of them again. The tests read frames with
// `id: -1` for "no id line" (see toolCallFrames in helpers.ts). Each test fails on the current
// source because the feed emits only the first closed call per event.

const start = useHarness();
const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const at = (i: number) => new Date(T0 + i * 1000).toISOString();
const AGENT = "par-agent";
const SESSION = "sess-par";
const NO_ID = -1;

type H = Awaited<ReturnType<typeof start>>;
type Boundary = "session.turn_ended" | "session.ended";

const startCall = (toolCallId: string, i: number) => ({
  type: "tool_call.started",
  agentId: AGENT,
  sessionId: SESSION,
  at: at(i),
  payload: { toolCallId, toolName: "Bash" },
});

const boundaryEvent = (type: Boundary) => ({
  type,
  agentId: AGENT,
  sessionId: SESSION,
  at: at(9),
  payload: {},
});

/** Two parallel running calls of one agent; returns the sequence of the last start. */
async function twoRunning(h: H): Promise<number> {
  h.addProject("spike", SPIKE_CWD);
  ingestRaw(h, "spike", "par-starts", [startCall("toolu_par_a", 0), startCall("toolu_par_b", 1)]);
  return h.engine.storage.head("spike") ?? 0;
}

function closeWith(h: H, type: Boundary): number {
  ingestRaw(h, "spike", `par-${type}`, [boundaryEvent(type)]);
  return h.engine.storage.head("spike") ?? 0;
}

/** Reads toolcall frames until the feed has been quiet for `quietMs`. */
async function drain(
  reader: SseReader,
  quietMs = 400,
): Promise<{ id: number; data: ToolCallFrame }[]> {
  const out: { id: number; data: ToolCallFrame }[] = [];
  for (;;) {
    let frame: Awaited<ReturnType<SseReader["next"]>>;
    try {
      frame = await reader.next(quietMs);
    } catch {
      return out;
    }
    if (frame === null) return out;
    if (frame.event === "toolcall") {
      out.push({ id: frame.id ?? NO_ID, data: frame.data as ToolCallFrame });
    }
  }
}

const summary = (frames: { id: number; data: ToolCallFrame }[]) =>
  frames.map((f) => [f.data.toolCallId, f.data.phase]);

/** The boundary's two frames: both calls unfinished, no id on the first, the event's id on the last. */
function expectBoundaryFrames(
  frames: { id: number; data: ToolCallFrame }[],
  boundarySeq: number,
): void {
  expect(frames).toHaveLength(2);
  expect(new Set(summary(frames).map((s) => s.join(":")))).toEqual(
    new Set(["toolu_par_a:unfinished", "toolu_par_b:unfinished"]),
  );
  expect(frames.map((f) => f.id)).toEqual([NO_ID, boundarySeq]);
  for (const frame of frames) {
    expect(frame.data.finishedAt).toBe(at(9));
    expect(frame.data).not.toHaveProperty("durationMs");
    expect(frame.data.toolName).toBe("Bash");
    expect(frame.data.evidence.output).toBeNull();
  }
}

describe.each([
  ["a turn end", "session.turn_ended"],
  ["a session end", "session.ended"],
] as const)("two parallel running calls of one agent at %s", (_label, boundary) => {
  it("shows both as unfinished in a backlog read, only the last frame carrying the event id", async () => {
    const h = await start();
    await twoRunning(h);
    const boundarySeq = closeWith(h, boundary);
    const reader = await h.openFeed(AGENT);
    const frames = await drain(reader);
    await reader.cancel();
    expect(summary(frames.slice(0, 2))).toEqual([
      ["toolu_par_a", "running"],
      ["toolu_par_b", "running"],
    ]);
    expectBoundaryFrames(frames.slice(2), boundarySeq);
  });

  it("sends both as unfinished live, only the last frame carrying the event id", async () => {
    const h = await start();
    await twoRunning(h);
    const reader = await h.openFeed(AGENT);
    expect(summary(await drain(reader))).toEqual([
      ["toolu_par_a", "running"],
      ["toolu_par_b", "running"],
    ]);
    const boundarySeq = closeWith(h, boundary);
    const frames = await drain(reader);
    await reader.cancel();
    expectBoundaryFrames(frames, boundarySeq);
  });

  it("replays both when a client reconnects with ?after= the id before the event", async () => {
    const h = await start();
    const lastStart = await twoRunning(h);
    const boundarySeq = closeWith(h, boundary);
    const reader = await h.openFeed(AGENT, `?after=${lastStart}`);
    const frames = await drain(reader);
    await reader.cancel();
    expectBoundaryFrames(frames, boundarySeq);
  });

  it("replays both live-resumed too: a feed opened before the event, then reconnected before it", async () => {
    const h = await start();
    const lastStart = await twoRunning(h);
    const first = await h.openFeed(AGENT, `?after=${lastStart}`);
    const boundarySeq = closeWith(h, boundary);
    expectBoundaryFrames(await drain(first), boundarySeq);
    await first.cancel();
    const again = await h.openFeed(AGENT, `?after=${lastStart}`);
    expectBoundaryFrames(await drain(again), boundarySeq);
    await again.cancel();
  });

  it("sends neither again when a client reconnects with ?after= the event's id", async () => {
    const h = await start();
    await twoRunning(h);
    const boundarySeq = closeWith(h, boundary);
    const reader = await h.openFeed(AGENT, `?after=${boundarySeq}`);
    const frames = await drain(reader);
    await reader.cancel();
    expect(summary(frames)).toEqual([]);
  });
});

// M5.15 round 2 (roborev 6739): an unregistered helper starts a call in a session before its owner
// has reported anything. The owner's first event is the turn end, and the reducer establishes the
// session's owner while reducing that very event, then closes the helper's call. The feed must
// look the closure up after the event, not in the pre-event state, so the helper's call arrives as
// unfinished.
describe("a helper's call closed by a boundary that first establishes session ownership", () => {
  const HELPER = "late-owner-helper";
  const OWNER = "late-owner";
  const LATE_SESSION = "sess-late-owner";
  const helperStart = {
    type: "tool_call.started",
    agentId: HELPER,
    sessionId: LATE_SESSION,
    at: at(0),
    payload: { toolCallId: "toolu_late_helper", toolName: "Read" },
  };
  const ownerTurnEnd = {
    type: "session.turn_ended",
    agentId: OWNER,
    sessionId: LATE_SESSION,
    at: at(5),
    payload: {},
  };

  it("sends the helper's call as unfinished in a backlog read", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    ingestRaw(h, "spike", "late-helper", [helperStart]);
    ingestRaw(h, "spike", "late-owner-end", [ownerTurnEnd]);
    const boundarySeq = h.engine.storage.head("spike") ?? 0;
    const reader = await h.openFeed(HELPER);
    const frames = await drain(reader);
    await reader.cancel();
    expect(summary(frames)).toEqual([
      ["toolu_late_helper", "running"],
      ["toolu_late_helper", "unfinished"],
    ]);
    expect(frames[1]?.id).toBe(boundarySeq);
    expect(frames[1]?.data.finishedAt).toBe(at(5));
  });

  it("sends the helper's call as unfinished live", async () => {
    const h = await start();
    h.addProject("spike", SPIKE_CWD);
    ingestRaw(h, "spike", "late-helper", [helperStart]);
    const reader = await h.openFeed(HELPER);
    expect(summary(await drain(reader))).toEqual([["toolu_late_helper", "running"]]);
    ingestRaw(h, "spike", "late-owner-end", [ownerTurnEnd]);
    const boundarySeq = h.engine.storage.head("spike") ?? 0;
    const frames = await drain(reader);
    await reader.cancel();
    expect(summary(frames)).toEqual([["toolu_late_helper", "unfinished"]]);
    expect(frames[0]?.id).toBe(boundarySeq);
  });
});

// M5.15 round 3 (roborev 6775): retention runs in the same reduce as the boundary. A finished
// session owner kept only by a late running call stops being kept when the boundary closes that
// call; with 50 newer finished agents retention then drops the owner and its session. The
// unregistered helper's running call in that session is closed by the same boundary all the same,
// so the feed must find it from the rule applied before retention, not in the retained state.
describe("a helper's call closed by a boundary whose owner retention then drops", () => {
  const HELPER = "retained-helper";
  const OWNER = "retained-owner";
  const RET_SESSION = "sess-retained-owner";
  const NEWER = Array.from({ length: 50 }, (_, i) => `retained-newer-${i}`);

  const setup = (h: H) => {
    h.addProject("spike", SPIKE_CWD);
    ingestRaw(h, "spike", "ret-owner", [
      { type: "session.started", agentId: OWNER, sessionId: RET_SESSION, at: at(0), payload: {} },
      { type: "agent.finished", agentId: OWNER, sessionId: RET_SESSION, at: at(1), payload: {} },
      {
        type: "tool_call.started",
        agentId: OWNER,
        sessionId: RET_SESSION,
        at: at(2),
        payload: { toolCallId: "toolu_ret_owner", toolName: "Bash" },
      },
    ]);
    ingestRaw(
      h,
      "spike",
      "ret-newer",
      NEWER.map((agentId, i) => ({
        type: "agent.finished",
        agentId,
        at: at(10 + i),
        payload: {},
      })),
    );
    ingestRaw(h, "spike", "ret-helper", [
      {
        type: "tool_call.started",
        agentId: HELPER,
        sessionId: RET_SESSION,
        at: at(3),
        payload: { toolCallId: "toolu_ret_helper", toolName: "Read" },
      },
    ]);
  };
  const ownerTurnEnd = {
    type: "session.turn_ended",
    agentId: OWNER,
    sessionId: RET_SESSION,
    at: at(100),
    payload: {},
  };

  it("sends the helper's call as unfinished in a backlog read", async () => {
    const h = await start();
    setup(h);
    ingestRaw(h, "spike", "ret-end", [ownerTurnEnd]);
    const boundarySeq = h.engine.storage.head("spike") ?? 0;
    const reader = await h.openFeed(HELPER);
    const frames = await drain(reader);
    await reader.cancel();
    expect(summary(frames)).toEqual([
      ["toolu_ret_helper", "running"],
      ["toolu_ret_helper", "unfinished"],
    ]);
    expect(frames[1]?.id).toBe(boundarySeq);
  });

  it("sends the helper's call as unfinished live", async () => {
    const h = await start();
    setup(h);
    const reader = await h.openFeed(HELPER);
    expect(summary(await drain(reader))).toEqual([["toolu_ret_helper", "running"]]);
    ingestRaw(h, "spike", "ret-end", [ownerTurnEnd]);
    const boundarySeq = h.engine.storage.head("spike") ?? 0;
    const frames = await drain(reader);
    await reader.cancel();
    expect(summary(frames)).toEqual([["toolu_ret_helper", "unfinished"]]);
    expect(frames[0]?.id).toBe(boundarySeq);
  });
});
