import type { StoredEnvelope } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { type ProjectState, replay } from "../../src/reducer/index.ts";
import { attention } from "../../src/selectors/index.ts";
import { type Emit, type EnvelopeFields, eventStream } from "./events.ts";

// M2.13: reducer rules for real Claude Code sessions (data-model.md "Unfinished tool calls",
// Session ownership, the teammate waiting rule, and decision #184 D1).

const run = (events: StoredEnvelope[]): ProjectState => replay("p1", events);

const CC = "claude-code";
const S1 = "1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const LEAD_ID = `${CC}:${S1}`;
const SUB_ID = `${CC}:${S1}:afdf84bea07a9064c`;
const HELPER_ID = `${CC}:${S1}:a0123456789abcdef`;
const LEAD: EnvelopeFields = { agentId: LEAD_ID, sessionId: S1, sourceId: CC };
const SUB: EnvelopeFields = { agentId: SUB_ID, sessionId: S1, sourceId: CC };
const HELPER: EnvelopeFields = { agentId: HELPER_ID, sessionId: S1, sourceId: CC };

const register = (emit: Emit, fields: EnvelopeFields, kind: "session" | "subagent" | "teammate") =>
  emit(
    "agent.registered",
    { sourceAgentId: String(fields.agentId), displayName: kind, role: "dev", kind },
    { agentId: fields.agentId, sourceId: CC },
  );
const start = (emit: Emit, id: string, fields: EnvelopeFields, toolName = "Bash") =>
  emit("tool_call.started", { toolCallId: id, toolName }, fields);
const finish = (emit: Emit, id: string, fields: EnvelopeFields, phase: "succeeded" | "failed") =>
  emit("tool_call.finished", { toolCallId: id, phase }, fields);

describe("unfinished tool calls (a)", () => {
  const boundaries: Array<[string, (emit: Emit, f: EnvelopeFields) => StoredEnvelope]> = [
    ["session.turn_ended", (emit, f) => emit("session.turn_ended", {}, f)],
    ["session.turn_failed", (emit, f) => emit("session.turn_failed", {}, f)],
    ["session.prompt_submitted", (emit, f) => emit("session.prompt_submitted", {}, f)],
    ["session.ended", (emit, f) => emit("session.ended", {}, f)],
    [
      "agent.finished",
      (emit, f) => emit("agent.finished", {}, { agentId: f.agentId, sourceId: CC }),
    ],
  ];

  it.each(boundaries)("the agent's own %s closes its running call as unfinished", (_, make) => {
    const emit = eventStream();
    const events = [emit("session.started", {}, LEAD), start(emit, "t1", LEAD)];
    const boundary = make(emit, LEAD);
    const state = run([...events, boundary]);
    expect(state.toolCalls.t1).toMatchObject({
      phase: "unfinished",
      finishedAt: boundary.occurredAt,
    });
  });

  it("an S-1 denied call (no PostToolUse) is unfinished after the turn ends, never succeeded", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, LEAD),
      emit("session.prompt_submitted", {}, LEAD),
      start(emit, "denied", LEAD),
      emit("session.turn_ended", {}, LEAD),
    ]);
    expect(state.toolCalls.denied?.phase).toBe("unfinished");
    expect(Object.values(state.toolCalls).filter((c) => c.phase === "running")).toEqual([]);
  });

  it("does not count as a failure, a success, or a cleared turn", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, LEAD),
      start(emit, "f1", LEAD),
      finish(emit, "f1", LEAD, "failed"),
      start(emit, "f2", LEAD),
      finish(emit, "f2", LEAD, "failed"),
      start(emit, "open", LEAD),
      emit("session.turn_ended", {}, LEAD),
    ]);
    const lead = state.agents[LEAD_ID];
    expect(state.toolCalls.open?.phase).toBe("unfinished");
    expect(lead?.consecutiveToolFailures).toBe(2);
    expect(lead?.toolCallCount).toBe(3);
    expect(lead?.lastTurn).toBe("ended");
  });

  it("a later PostToolUse replaces unfinished with the recorded result", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, LEAD),
      start(emit, "t1", LEAD),
      emit("session.turn_ended", {}, LEAD),
      finish(emit, "t1", LEAD, "succeeded"),
    ]);
    expect(state.toolCalls.t1?.phase).toBe("succeeded");
    expect(state.agents[LEAD_ID]?.toolCallCount).toBe(1);
  });

  it("an unregistered helper's call closes at the session owner's turn end (S-2)", () => {
    const emit = eventStream();
    const state = run([
      register(emit, LEAD, "session"),
      emit("session.started", {}, LEAD),
      start(emit, "helper-call", HELPER),
      emit("session.turn_ended", {}, LEAD),
    ]);
    expect(state.toolCalls["helper-call"]?.phase).toBe("unfinished");
  });

  it("a registered subagent's call keeps running past its parent's Stop (background subagents)", () => {
    const emit = eventStream();
    const state = run([
      register(emit, LEAD, "session"),
      emit("session.started", {}, LEAD),
      register(emit, SUB, "subagent"),
      start(emit, "bg", SUB),
      emit("session.turn_ended", {}, LEAD),
    ]);
    expect(state.toolCalls.bg?.phase).toBe("running");
  });

  it("session.ended closes every running call in the session, whoever owns it", () => {
    const emit = eventStream();
    const state = run([
      register(emit, LEAD, "session"),
      emit("session.started", {}, LEAD),
      register(emit, SUB, "subagent"),
      start(emit, "bg", SUB),
      start(emit, "other-session", { ...SUB, sessionId: "s-other" }),
      emit("session.ended", {}, LEAD),
    ]);
    expect(state.toolCalls.bg?.phase).toBe("unfinished");
    expect(state.toolCalls["other-session"]?.phase).toBe("running");
  });

  it("a turn in another session leaves the call alone", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, LEAD),
      emit("session.started", {}, { ...LEAD, sessionId: "s2" }),
      start(emit, "t1", LEAD),
      emit("session.turn_ended", {}, { ...LEAD, sessionId: "s2" }),
    ]);
    expect(state.toolCalls.t1?.phase).toBe("running");
  });

  it("keeps one finished call per agent when a boundary closes several (bounded state)", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, LEAD),
      start(emit, "t1", LEAD),
      start(emit, "t2", LEAD),
      start(emit, "t3", LEAD),
      emit("session.turn_ended", {}, LEAD),
    ]);
    expect(Object.keys(state.toolCalls)).toEqual(["t3"]);
    expect(state.toolCalls.t3?.phase).toBe("unfinished");
  });
});

describe("session ownership (b)", () => {
  it("a subagent's tool activity seen first never takes the lead's session", () => {
    const emit = eventStream();
    const state = run([
      emit("activity.started", { activity: "implementing" }, SUB),
      emit("session.started", {}, LEAD),
      emit("session.turn_ended", {}, LEAD),
      emit("session.ended", {}, LEAD),
    ]);
    expect(state.sessions[S1]?.agentId).toBe(LEAD_ID);
    expect(state.sessions[S1]?.endedAt).toBeDefined();
    expect(state.agents[LEAD_ID]?.lastTurn).toBe("ended");
  });

  it("a registered subagent never owns a session, whatever its ID", () => {
    const emit = eventStream();
    const sub = { agentId: "sub-x", sessionId: "s9", sourceId: "test" };
    const state = run([
      emit(
        "agent.registered",
        { sourceAgentId: "x", displayName: "x", role: "r", kind: "subagent" },
        { agentId: "sub-x" },
      ),
      emit("activity.started", { activity: "testing" }, sub),
      emit("session.started", {}, sub),
    ]);
    expect(state.sessions.s9).toBeUndefined();
    expect(state.activity["sub-x"]?.activity).toBe("testing");
  });

  it("an in-process teammate (nested ID) never owns the lead's session", () => {
    const emit = eventStream();
    const mate = { agentId: `${CC}:${S1}:apip-5cb5e9bb3f2f1097`, sessionId: S1, sourceId: CC };
    const state = run([
      register(emit, mate, "teammate"),
      emit("activity.started", { activity: "implementing" }, mate),
      emit("session.started", {}, LEAD),
    ]);
    expect(state.sessions[S1]?.agentId).toBe(LEAD_ID);
  });

  it("a split-pane teammate still owns its own session", () => {
    const emit = eventStream();
    const own = {
      agentId: `${CC}:b0b0b0b0-0000-4000-8000-000000000001`,
      sessionId: "b0b0b0b0-0000-4000-8000-000000000001",
      sourceId: CC,
    };
    const state = run([
      emit("session.started", {}, own),
      register(emit, own, "teammate"),
      emit("activity.started", { activity: "testing" }, own),
    ]);
    expect(state.sessions[String(own.sessionId)]?.agentId).toBe(own.agentId);
    expect(state.activity[String(own.agentId)]?.activity).toBe("testing");
  });

  it("an unregistered agent of another source still owns the session it names first", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, { agentId: "x:y:z", sessionId: "s5", sourceId: "test" }),
    ]);
    expect(state.sessions.s5?.agentId).toBe("x:y:z");
  });
});

describe("split-pane teammate Stop is not waiting (c)", () => {
  const now = Date.parse("2026-10-30T12:00:00Z");
  const mate = {
    agentId: `${CC}:b0b0b0b0-0000-4000-8000-000000000002`,
    sessionId: "b0b0b0b0-0000-4000-8000-000000000002",
    sourceId: CC,
  };

  it.each([
    ["registered before the Stop", true],
    ["registered after the Stop", false],
  ])("a teammate %s raises no waiting and no silent trouble", (_, first) => {
    const emit = eventStream();
    const reg = () => register(emit, mate, "teammate");
    const events = first
      ? [emit("session.started", {}, mate), reg(), emit("session.turn_ended", {}, mate)]
      : [emit("session.started", {}, mate), emit("session.turn_ended", {}, mate), reg()];
    const state = run([...events, emit("agent.connected", {}, mate)]);
    expect(attention(state, now).filter((r) => r.agentId === mate.agentId)).toEqual([]);
  });

  it("a session agent's Stop still raises waiting", () => {
    const emit = eventStream();
    const state = run([emit("session.started", {}, LEAD), emit("session.turn_ended", {}, LEAD)]);
    expect(attention(state, now).map((r) => [r.agentId, r.level, r.kind])).toEqual([
      [LEAD_ID, "waiting", "turn_ended"],
    ]);
  });
});

describe("telemetry request closure, decision #184 D1 default (d)", () => {
  const opened = (emit: Emit, requestId: string, fields: EnvelopeFields, sourceId = CC) =>
    emit("request.opened", { requestId, kind: "permission" }, { ...fields, sourceId });

  it("a subagent's tool call in the lead's session does not close the lead's prompt", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "r1", LEAD),
      start(emit, "t1", SUB),
      finish(emit, "t1", SUB, "succeeded"),
      emit("session.turn_failed", {}, SUB),
    ]);
    expect(state.requests.r1?.state).toBe("open");
  });

  it("the owner's tool call closes it", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "r1", LEAD),
      start(emit, "t1", LEAD),
      finish(emit, "t1", LEAD, "succeeded"),
    ]);
    expect(state.requests.r1?.state).toBe("answered_elsewhere");
  });

  it.each(["session.turn_ended", "session.prompt_submitted", "session.ended"] as const)(
    "%s from any agent in the session closes it",
    (type) => {
      const emit = eventStream();
      const state = run([opened(emit, "r1", SUB), emit(type, {}, LEAD)]);
      expect(state.requests.r1?.state).toBe("answered_elsewhere");
    },
  );

  it("a bridge-held request is not closed by another agent's tool result either (#116 D3)", () => {
    const emit = eventStream();
    const state = run([
      opened(emit, "b1", LEAD, "taskville:bridge"),
      start(emit, "t1", SUB),
      finish(emit, "t1", SUB, "succeeded"),
    ]);
    expect(state.requests.b1?.state).toBe("open");
    expect(state.requests.b1?.answerable).toBe(true);
  });
});
