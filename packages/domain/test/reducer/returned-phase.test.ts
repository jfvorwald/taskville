import type { StoredEnvelope } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { type ProjectState, replay } from "../../src/reducer/index.ts";
import { type Emit, eventStream } from "./events.ts";

// A1.00: a call that finished with phase `returned` is finished (not running), not failed, and
// not a success. Its outcome was not reported (constitution IV).

const run = (events: StoredEnvelope[]): ProjectState => replay("p1", events);
const s = { agentId: "a1", sessionId: "s1" };
const reason = (text: string) => ({ text, masked: false, truncated: false });

function base(emit: Emit) {
  return [
    emit(
      "agent.registered",
      { sourceAgentId: "src-a1", displayName: "a1", role: "dev", kind: "session" },
      { agentId: "a1" },
    ),
  ];
}

describe("returned tool call", () => {
  it("records the call as finished with phase returned", () => {
    const emit = eventStream();
    const state = run([
      ...base(emit),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Edit" }, s),
      emit("tool_call.finished", { toolCallId: "t1", phase: "returned", durationMs: 7 }, s),
    ]);
    const call = state.toolCalls.t1;
    expect(call?.phase).toBe("returned");
    expect(call?.finishedAt).toBeDefined();
    expect(call?.durationMs).toBe(7);
    expect(call?.toolName).toBe("Edit");
  });

  it("does not leave the call running, so a later finish for it is ignored", () => {
    const emit = eventStream();
    const state = run([
      ...base(emit),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Edit" }, s),
      emit("tool_call.finished", { toolCallId: "t1", phase: "returned" }, s),
      emit("tool_call.finished", { toolCallId: "t1", phase: "failed" }, s),
    ]);
    expect(state.toolCalls.t1?.phase).toBe("returned");
  });

  it("is not closed as unfinished at a session boundary", () => {
    const emit = eventStream();
    const state = run([
      ...base(emit),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Edit" }, s),
      emit("tool_call.finished", { toolCallId: "t1", phase: "returned" }, s),
      emit("session.ended", {}, s),
    ]);
    expect(state.toolCalls.t1?.phase).toBe("returned");
  });

  it("is not a failure: the failure streak does not grow", () => {
    const emit = eventStream();
    const state = run([
      ...base(emit),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Bash" }, s),
      emit("tool_call.finished", { toolCallId: "t1", phase: "failed" }, s),
      emit("tool_call.started", { toolCallId: "t2", toolName: "Bash" }, s),
      emit("tool_call.finished", { toolCallId: "t2", phase: "returned" }, s),
    ]);
    expect(state.agents.a1?.consecutiveToolFailures).toBeLessThanOrEqual(1);
    expect(state.agents.a1?.toolCallCount).toBe(2);
  });

  it("is not a success: it does not clear a failed turn", () => {
    const emit = eventStream();
    const state = run([
      ...base(emit),
      emit("session.turn_failed", { reason: reason("api error") }, s),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Bash" }, s),
      emit("tool_call.finished", { toolCallId: "t1", phase: "returned" }, s),
    ]);
    expect(state.toolCalls.t1?.phase).toBe("returned");
    expect(state.agents.a1?.lastTurn).toBe("failed");
  });

  it("still keeps only the latest finished call per agent", () => {
    const emit = eventStream();
    const state = run([
      ...base(emit),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Edit" }, s),
      emit("tool_call.finished", { toolCallId: "t1", phase: "returned" }, s),
      emit("tool_call.started", { toolCallId: "t2", toolName: "Edit" }, s),
      emit("tool_call.finished", { toolCallId: "t2", phase: "succeeded" }, s),
    ]);
    expect(Object.keys(state.toolCalls)).toEqual(["t2"]);
    expect(state.toolCalls.t2?.phase).toBe("succeeded");
  });
});
