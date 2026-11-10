import { initialState, reduce } from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ToolCallTracker } from "../../src/feed/tool-calls.ts";
import type { SseReader } from "../stream/helpers.ts";
import { ingestRaw, SPIKE_CWD, type ToolCallFrame, useHarness } from "./helpers.ts";

// M5.14 (#281), scope added by the lead from the M5.15 confirming review: the feed's boundary
// closure lookup runs the reducer's entity step again for an event, which about doubled the cost
// of a long backlog. Cost is COUNTED (calls of `reduceEntities`), never timed (L-206). The module
// is wrapped so the real function runs and every call is recorded; the reducer's own internal use
// of it is not affected (it calls its sibling directly), so the counter sees the feed's calls only.
// The ordering and frame-shape tests pin M5.15's scheme and pass now; they guard the guard.

vi.mock("@taskville/domain/reducer", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@taskville/domain/reducer")>();
  return { ...actual, reduceEntities: vi.fn(actual.reduceEntities) };
});

const reducerModule = await import("@taskville/domain/reducer");
const entityCalls = () => vi.mocked(reducerModule.reduceEntities);

beforeEach(() => {
  entityCalls().mockClear();
});

const T0 = Date.parse("2026-10-31T10:00:00.000Z");
const at = (i: number) => new Date(T0 + i * 1000).toISOString();
const AGENT = "clo-agent";
const OTHER = "clo-other";
const SESSION = "clo-session";

let seq = 0;
function envelope(
  type: string,
  agentId: string,
  payload: Record<string, unknown>,
  sessionId = SESSION,
): StoredEnvelope {
  seq += 1;
  return {
    schemaVersion: 1,
    projectId: "p",
    sourceId: "adapter:test",
    sourceEventId: `clo-${seq}`,
    occurredAt: at(seq),
    type,
    agentId,
    sessionId,
    payload,
    provenance: "live",
    evidenceIds: [],
    late: false,
    eventId: `clo-event-${seq}`,
    receivedAt: at(seq),
    ingestSequence: seq,
  } as unknown as StoredEnvelope;
}

const started = (id: string) =>
  envelope("tool_call.started", AGENT, { toolCallId: id, toolName: "Bash" });

describe("the boundary closure lookup costs nothing for an event that leaves toolCalls unchanged", () => {
  // The events below are accepted by the reducer without touching `toolCalls` (checked in the
  // first test), while the agent has open calls: the case where the lookup ran every time.
  const quiet = () => [
    envelope("agent.connected", OTHER, {}, "clo-other-session"),
    envelope("agent.disconnected", OTHER, {}, "clo-other-session"),
    envelope("agent.finished", OTHER, {}, "clo-other-session"),
    envelope("agent.connected", AGENT, {}),
  ];

  it("precondition: these events really leave toolCalls unchanged in the reducer", () => {
    let state = initialState("p");
    state = reduce(state, started("toolu_clo_pre"));
    for (const event of quiet()) {
      const next = reduce(state, event);
      expect(next.toolCalls).toEqual(state.toolCalls);
      state = next;
    }
  });

  it("runs no entity step for such events while the agent has open calls", () => {
    const tracker = new ToolCallTracker("p", AGENT);
    tracker.apply(started("toolu_clo_1"));
    tracker.apply(started("toolu_clo_2"));
    expect(tracker.openCallCount()).toBe(2);

    const before = entityCalls().mock.calls.length;
    for (let round = 0; round < 25; round++) {
      for (const event of quiet()) {
        expect(tracker.applyAll(event)).toEqual([]);
      }
    }
    // Fails now: one entity step per event (100) for the lookup.
    expect(entityCalls().mock.calls.length - before).toBe(0);
  });

  it("still closes both calls at a boundary after the quiet events, with one lookup for it", () => {
    const tracker = new ToolCallTracker("p", AGENT);
    tracker.apply(started("toolu_clo_1"));
    tracker.apply(started("toolu_clo_2"));
    for (const event of quiet()) tracker.applyAll(event);

    const before = entityCalls().mock.calls.length;
    const closed = tracker.applyAll(envelope("session.turn_ended", AGENT, {}));
    expect(closed.map((c) => [c.toolCallId, c.phase])).toEqual([
      ["toolu_clo_1", "unfinished"],
      ["toolu_clo_2", "unfinished"],
    ]);
    // Guard against a guard that skips everything: the boundary itself does run the lookup, once.
    expect(entityCalls().mock.calls.length - before).toBe(1);
  });
});

describe("closed frames of one boundary", () => {
  const start = useHarness();
  type H = Awaited<ReturnType<typeof start>>;

  const call = (toolCallId: string, i: number) => ({
    type: "tool_call.started",
    agentId: AGENT,
    sessionId: SESSION,
    at: at(i),
    payload: { toolCallId, toolName: "Bash" },
  });
  const turnEnd = {
    type: "session.turn_ended",
    agentId: AGENT,
    sessionId: SESSION,
    at: at(20),
    payload: {},
  };

  async function drain(reader: SseReader): Promise<{ id: number; data: ToolCallFrame }[]> {
    const out: { id: number; data: ToolCallFrame }[] = [];
    for (;;) {
      let frame: Awaited<ReturnType<SseReader["next"]>>;
      try {
        frame = await reader.next(400);
      } catch {
        return out;
      }
      if (frame === null) return out;
      if (frame.event === "toolcall") {
        out.push({ id: frame.id ?? -1, data: frame.data as ToolCallFrame });
      }
    }
  }

  async function boundaryFrames(h: H, ids: string[]) {
    h.addProject("spike", SPIKE_CWD);
    ingestRaw(
      h,
      "spike",
      "clo-starts",
      ids.map((id, i) => call(id, i)),
    );
    ingestRaw(h, "spike", "clo-end", [turnEnd]);
    const head = h.engine.storage.head("spike") ?? 0;
    const reader = await h.openFeed(AGENT);
    const frames = await drain(reader);
    await reader.cancel();
    return { frames: frames.slice(ids.length), head };
  }

  it("lists the closed calls oldest start first, not in id order", async () => {
    const h = await start();
    // Started in the order z, a: id order would be the reverse.
    const { frames } = await boundaryFrames(h, ["toolu_clo_z", "toolu_clo_a"]);
    expect(frames.map((f) => [f.data.toolCallId, f.data.phase])).toEqual([
      ["toolu_clo_z", "unfinished"],
      ["toolu_clo_a", "unfinished"],
    ]);
  });

  it("emits two idless frames then one identified frame for a three-call boundary", async () => {
    const h = await start();
    const { frames, head } = await boundaryFrames(h, ["toolu_clo_3", "toolu_clo_1", "toolu_clo_2"]);
    expect(frames.map((f) => f.data.toolCallId)).toEqual([
      "toolu_clo_3",
      "toolu_clo_1",
      "toolu_clo_2",
    ]);
    expect(frames.every((f) => f.data.phase === "unfinished")).toBe(true);
    expect(frames.map((f) => f.id)).toEqual([-1, -1, head]);
  });
});
