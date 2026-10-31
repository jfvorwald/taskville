import type { StoredEnvelope } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { stateHash } from "../../src/hash/index.ts";
import {
  initialState,
  MAX_OPEN_TOOL_CALLS_PER_AGENT,
  type ProjectState,
  projectStateHash,
  REDUCER_VERSION,
  reduce,
  replay,
} from "../../src/reducer/index.ts";
import { deepFreeze, type Emit, eventStream } from "./events.ts";

const reason = (text: string) => ({ text, masked: false, truncated: false });

/** Registers an agent with sensible defaults. */
function registered(
  emit: Emit,
  agentId: string,
  kind: "session" | "subagent" | "lead" | "teammate" | "unknown",
  extra: { parentAgentId?: string; teamId?: string; sourceValue?: string; sourceId?: string } = {},
) {
  const { sourceId, ...payloadExtra } = extra;
  return emit(
    "agent.registered",
    { sourceAgentId: `src-${agentId}`, displayName: agentId, role: "dev", kind, ...payloadExtra },
    { agentId, ...(sourceId === undefined ? {} : { sourceId }) },
  );
}

const run = (events: StoredEnvelope[]): ProjectState => replay("p1", events);

describe("root reducer", () => {
  it("starts empty at head 0 with the reducer version", () => {
    expect(initialState("p1")).toEqual({
      projectId: "p1",
      reducerVersion: REDUCER_VERSION,
      head: 0,
      agents: {},
      teams: {},
      sessions: {},
      toolCalls: {},
      tasks: {},
      activity: {},
      requests: {},
      commands: {},
    });
  });

  it("composes the requests slice (M1.08) after entities", () => {
    const emit = eventStream();
    const opened = emit(
      "request.opened",
      { requestId: "r1", kind: "permission", toolName: "Bash" },
      { agentId: "a1", sessionId: "s1" },
    );
    const state = run([opened]);
    // Entities recorded the agent; the requests slice opened the request.
    expect(state.agents.a1).toMatchObject({ registered: false });
    expect(state.requests.r1).toMatchObject({ agentId: "a1", state: "open", answerable: false });
    // A later event from the same session closes it through the requests slice.
    const closed = reduce(
      state,
      emit("session.turn_ended", {}, { agentId: "a1", sessionId: "s1" }),
    );
    expect(closed.requests.r1?.state).toBe("answered_elsewhere");
    expect(closed.agents.a1?.lastTurn).toBe("ended");
  });

  it("keeps the requests slice unchanged for events it ignores", () => {
    const emit = eventStream();
    const state = run([
      emit("request.opened", { requestId: "r1", kind: "input" }, { agentId: "a1" }),
    ]);
    const next = reduce(state, emit("agent.connected", {}, { agentId: "a1" }));
    expect(next.requests).toBe(state.requests);
    expect(next.commands).toBe(state.commands);
  });

  it("sets head to the last applied ingest sequence", () => {
    const emit = eventStream();
    const events: StoredEnvelope[] = [
      emit("project.created", { name: "p", roots: [], builtin: false }),
    ];
    events.push(registered(emit, "a1", "session"));
    expect(run(events).head).toBe(2);
  });

  it("hashes state as <reducerVersion>:<sha256 of canonical JSON>", () => {
    const state = initialState("p1");
    expect(projectStateHash(state)).toBe(stateHash(REDUCER_VERSION, state));
    expect(projectStateHash(state)).toMatch(/^4:[0-9a-f]{64}$/);
  });

  it("rejects an event from another project", () => {
    const emit = eventStream();
    const event = emit("agent.connected", {}, { agentId: "a1", projectId: "p2" });
    expect(() => reduce(initialState("p1"), event)).toThrow(/p2/);
  });

  it("never mutates the state or the event it is given", () => {
    const emit = eventStream();
    let state = deepFreeze(initialState("p1"));
    const events = [
      registered(emit, "a1", "session"),
      emit("session.started", {}, { agentId: "a1", sessionId: "s1" }),
      emit("activity.started", { activity: "testing" }, { agentId: "a1", sessionId: "s1" }),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Bash" }, { agentId: "a1" }),
      emit("tool_call.finished", { toolCallId: "t1", phase: "failed" }, { agentId: "a1" }),
      emit("task.created", { title: "x" }, { taskId: "k1" }),
      emit("task.assigned", { agentIds: ["a1"] }, { taskId: "k1" }),
      emit("session.ended", {}, { agentId: "a1", sessionId: "s1" }),
    ];
    for (const event of events) state = deepFreeze(reduce(state, deepFreeze(event)));
    expect(state.head).toBe(events.length);
  });
});

describe("agents", () => {
  it("creates an agent from agent.registered with its source identity", () => {
    const emit = eventStream();
    const state = run([registered(emit, "a1", "session", { sourceId: "claude-code" })]);
    expect(state.agents.a1).toEqual({
      id: "a1",
      sourceId: "claude-code",
      sourceAgentId: "src-a1",
      displayName: "a1",
      role: "dev",
      kind: "session",
      registered: true,
      registeredSeq: 1,
      connection: "unknown",
      firstSeenAt: "2026-10-30T10:00:01Z",
      lastSeenAt: "2026-10-30T10:00:01Z",
      toolCallCount: 0,
      consecutiveToolFailures: 0,
    });
  });

  it("updates name and role on a later registration, keeping identity and order", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "a1", "session"),
      emit(
        "agent.registered",
        { sourceAgentId: "src-a1", displayName: "renamed", role: "reviewer", kind: "session" },
        { agentId: "a1" },
      ),
    ]);
    expect(state.agents.a1).toMatchObject({
      displayName: "renamed",
      role: "reviewer",
      registeredSeq: 1,
      firstSeenAt: "2026-10-30T10:00:01Z",
    });
  });

  it("ignores a registration that claims a different source identity for the same agent ID", () => {
    const emit = eventStream();
    const first = registered(emit, "a1", "session");
    const conflicting = emit(
      "agent.registered",
      { sourceAgentId: "someone-else", displayName: "impostor", role: "x", kind: "lead" },
      { agentId: "a1" },
    );
    const fromOtherSource = emit(
      "agent.registered",
      { sourceAgentId: "src-a1", displayName: "impostor", role: "x", kind: "lead" },
      { agentId: "a1", sourceId: "other-source" },
    );
    const state = run([first, conflicting, fromOtherSource]);
    expect(state.agents.a1).toMatchObject({
      sourceId: "test",
      sourceAgentId: "src-a1",
      displayName: "a1",
      kind: "session",
    });
  });

  it("keeps an unrecognized kind as unknown with the original value", () => {
    const emit = eventStream();
    const state = run([registered(emit, "a1", "unknown", { sourceValue: "orchestrator" })]);
    expect(state.agents.a1).toMatchObject({ kind: "unknown", sourceValue: "orchestrator" });
  });

  it("creates an unregistered placeholder when an agent acts before it registers", () => {
    const emit = eventStream();
    const before = run([
      emit("tool_call.started", { toolCallId: "t1", toolName: "Read" }, { agentId: "a1" }),
    ]);
    expect(before.agents.a1).toEqual({
      id: "a1",
      sourceId: "test",
      kind: "unknown",
      registered: false,
      connection: "unknown",
      firstSeenAt: "2026-10-30T10:00:01Z",
      lastSeenAt: "2026-10-30T10:00:01Z",
      toolCallCount: 1,
      consecutiveToolFailures: 0,
    });
    const emit2 = eventStream();
    const after = run([
      emit2("tool_call.started", { toolCallId: "t1", toolName: "Read" }, { agentId: "a1" }),
      registered(emit2, "a1", "subagent", { parentAgentId: "p0", sourceId: "claude-code" }),
    ]);
    expect(after.agents.a1).toMatchObject({
      sourceId: "claude-code",
      kind: "subagent",
      parentAgentId: "p0",
      registered: true,
      registeredSeq: 2,
      toolCallCount: 1,
      firstSeenAt: "2026-10-30T10:00:01Z",
    });
  });

  it("changes only connection on connect and disconnect", () => {
    const emit = eventStream();
    const base = [registered(emit, "a1", "session")];
    const connected = run([...base, emit("agent.connected", {}, { agentId: "a1" })]);
    expect(connected.agents.a1?.connection).toBe("connected");
    const disconnected = run([
      ...base,
      emit("agent.connected", {}, { agentId: "a1" }),
      emit("agent.disconnected", {}, { agentId: "a1" }),
    ]);
    expect(disconnected.agents.a1?.connection).toBe("disconnected");
  });

  it("keeps the task, assignment and activity when an agent disconnects", () => {
    const emit = eventStream();
    const before = [
      registered(emit, "a1", "session"),
      emit("agent.connected", {}, { agentId: "a1" }),
      emit("session.started", {}, { agentId: "a1", sessionId: "s1" }),
      emit("task.created", { title: "Build it" }, { taskId: "k1" }),
      emit("task.assigned", { agentIds: ["a1"] }, { taskId: "k1" }),
      emit("task.status_changed", { status: "running" }, { taskId: "k1" }),
      emit(
        "activity.started",
        { activity: "implementing" },
        { agentId: "a1", sessionId: "s1", taskId: "k1" },
      ),
    ];
    const connected = run(before);
    const disconnected = run([...before, emit("agent.disconnected", {}, { agentId: "a1" })]);
    expect(disconnected.tasks).toEqual(connected.tasks);
    expect(disconnected.tasks.k1).toMatchObject({ status: "running", assignedAgentIds: ["a1"] });
    expect(disconnected.activity).toEqual(connected.activity);
    expect(disconnected.activity.a1).toMatchObject({ activity: "implementing", taskId: "k1" });
    expect(disconnected.sessions).toEqual(connected.sessions);
    expect(disconnected.agents.a1).toMatchObject({ connection: "disconnected" });
    expect(disconnected.agents.a1?.finishedAt).toBeUndefined();
  });

  it("sets finishedAt on agent.finished and nothing else", () => {
    const emit = eventStream();
    const base = [
      registered(emit, "a1", "subagent"),
      emit("agent.connected", {}, { agentId: "a1" }),
    ];
    const finished = run([...base, emit("agent.finished", { outcome: "done" }, { agentId: "a1" })]);
    expect(finished.agents.a1).toMatchObject({
      finishedAt: "2026-10-30T10:00:03Z",
      connection: "connected",
      kind: "subagent",
    });
  });

  it("tracks lastSeenAt as the latest occurrence time, not the latest event", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "a1", "session"),
      emit("agent.connected", {}, { agentId: "a1", occurredAt: "2026-10-30T12:00:00+02:00" }),
      // 10:30Z is later than 12:00+02:00 (10:00Z) even though it sorts lower as text.
      emit("agent.connected", {}, { agentId: "a1", occurredAt: "2026-10-30T10:30:00Z" }),
      // A late event from the spool is older and must not move lastSeenAt back.
      emit(
        "agent.connected",
        {},
        { agentId: "a1", occurredAt: "2026-10-30T09:00:00Z", late: true },
      ),
    ]);
    expect(state.agents.a1?.lastSeenAt).toBe("2026-10-30T10:30:00Z");
  });

  it("counts any event naming the agent as seeing it, including requests", () => {
    const emit = eventStream();
    const state = run([
      emit("request.opened", { requestId: "r1", kind: "permission" }, { agentId: "a9" }),
    ]);
    expect(state.agents.a9).toMatchObject({ registered: false, kind: "unknown" });
  });

  it("handles agent IDs that collide with Object.prototype names", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "__proto__", "session"),
      registered(emit, "constructor", "session"),
      emit("agent.connected", {}, { agentId: "toString" }),
    ]);
    expect(Object.keys(state.agents).sort()).toEqual(["__proto__", "constructor", "toString"]);
    expect(Object.getPrototypeOf(state.agents)).toBe(Object.prototype);
    expect(Object.hasOwn(state.agents, "__proto__")).toBe(true);
    expect(state.agents.constructor).toMatchObject({ kind: "session", registered: true });
    expect(JSON.parse(JSON.stringify(state.agents))).toEqual(state.agents);
  });
});

describe("heuristic registrations (#120): suggestions, never facts", () => {
  // The Claude Code adapter names a split-pane teammate from its first SendMessage before any
  // recorded TeammateIdle, and marks that registration heuristic. Constitution IV: a heuristic
  // link is a suggestion. It never overrides a recorded name or kind, and never sets a link.
  const guess = (emit: Emit, agentId: string, extra: { teamId?: string } = {}) =>
    emit(
      "agent.registered",
      {
        sourceAgentId: `src-${agentId}`,
        displayName: "pip",
        role: "teammate",
        kind: "teammate",
        heuristic: true,
        ...extra,
      },
      { agentId },
    );

  it("recorded first: keeps the recorded name and kind, and holds the guess as a suggestion", () => {
    const emit = eventStream();
    const state = run([registered(emit, "s", "session"), guess(emit, "s")]);
    expect(state.agents.s).toMatchObject({
      displayName: "s",
      kind: "session",
      registered: true,
      heuristic: { displayName: "pip", kind: "teammate" },
    });
  });

  it("heuristic first: a later recorded registration replaces the suggestion", () => {
    const emit = eventStream();
    const guessed = run([guess(emit, "s")]);
    // The guess alone does not register the agent or name it.
    expect(guessed.agents.s).toMatchObject({
      registered: false,
      kind: "unknown",
      heuristic: { displayName: "pip", kind: "teammate" },
    });
    expect(guessed.agents.s?.displayName).toBeUndefined();
    const recorded = run([guess(emit, "s"), registered(emit, "s", "teammate", { teamId: "t1" })]);
    expect(recorded.agents.s).toMatchObject({ displayName: "s", kind: "teammate", teamId: "t1" });
    expect(recorded.agents.s?.heuristic).toBeUndefined();
  });

  it("drops a guess that only repeats what is recorded", () => {
    const emit = eventStream();
    const recorded = emit(
      "agent.registered",
      { sourceAgentId: "src-s", displayName: "pip", role: "teammate", kind: "teammate" },
      { agentId: "s" },
    );
    const state = run([recorded, guess(emit, "s")]);
    expect(state.agents.s?.heuristic).toBeUndefined();
  });

  it("never sets a team or parent link from a guess", () => {
    const emit = eventStream();
    const state = run([
      emit("team.started", { teamId: "t1", leadAgentId: "lead" }, {}),
      guess(emit, "s", { teamId: "t1" }),
    ]);
    expect(state.agents.s?.teamId).toBeUndefined();
    expect(state.teams.t1?.memberAgentIds).toEqual([]);
  });
});

describe("parentage", () => {
  it("links a subagent to its parent, and a nested subagent to that subagent", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "main", "session"),
      registered(emit, "outer", "subagent", { parentAgentId: "main" }),
      registered(emit, "inner", "subagent", { parentAgentId: "outer" }),
    ]);
    expect(state.agents.outer?.parentAgentId).toBe("main");
    expect(state.agents.inner?.parentAgentId).toBe("outer");
    expect(state.agents.main?.parentAgentId).toBeUndefined();
  });

  it("leaves the parent unknown until a later registration supplies it, and never guesses", () => {
    // S-2: the only recorded link is the parent's PostToolUse(Agent), which can arrive after
    // the subagent has started (or, for a synchronous call, after it has stopped).
    const emit = eventStream();
    const early = [
      registered(emit, "main", "session"),
      registered(emit, "sub", "subagent"),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Read" }, { agentId: "sub" }),
    ];
    expect(run(early).agents.sub?.parentAgentId).toBeUndefined();
    const linked = run([...early, registered(emit, "sub", "subagent", { parentAgentId: "main" })]);
    expect(linked.agents.sub?.parentAgentId).toBe("main");
    // A re-registration that omits the parent does not erase a recorded one.
    const again = run([
      ...early,
      registered(emit, "sub", "subagent", { parentAgentId: "main" }),
      registered(emit, "sub", "subagent"),
    ]);
    expect(again.agents.sub?.parentAgentId).toBe("main");
  });

  it("drops parent and team links that the new kind does not allow", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "x", "subagent", { parentAgentId: "main" }),
      registered(emit, "x", "session"),
      registered(emit, "y", "teammate", { teamId: "team1" }),
      registered(emit, "y", "subagent", { parentAgentId: "x" }),
    ]);
    expect(state.agents.x?.parentAgentId).toBeUndefined();
    expect(state.agents.y?.teamId).toBeUndefined();
    expect(state.agents.y?.parentAgentId).toBe("x");
  });

  it("builds a team from its lead and teammates, ordered by registration", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "lead", "lead", { teamId: "team1" }),
      // pip registers before the team.started event arrives (async hooks race, S-2).
      registered(emit, "pip", "teammate", { teamId: "team1" }),
      emit("team.started", { teamId: "team1", leadAgentId: "lead", name: "crew" }),
      registered(emit, "bo", "teammate", { teamId: "team1" }),
      registered(emit, "solo", "session"),
    ]);
    expect(state.teams.team1).toEqual({
      id: "team1",
      leadAgentId: "lead",
      name: "crew",
      memberAgentIds: ["lead", "pip", "bo"],
      startedAt: "2026-10-30T10:00:03Z",
    });
    expect(state.agents.pip).toMatchObject({ kind: "teammate", teamId: "team1" });
    expect(state.agents.pip?.parentAgentId).toBeUndefined();
  });

  it("links a teammate's own subagent to the teammate", () => {
    const emit = eventStream();
    const state = run([
      emit("team.started", { teamId: "team1", leadAgentId: "lead" }),
      registered(emit, "lead", "lead", { teamId: "team1" }),
      registered(emit, "pip", "teammate", { teamId: "team1" }),
      registered(emit, "helper", "subagent", { parentAgentId: "pip" }),
    ]);
    expect(state.agents.helper).toMatchObject({ kind: "subagent", parentAgentId: "pip" });
    expect(state.agents.helper?.teamId).toBeUndefined();
    expect(state.teams.team1?.memberAgentIds).toEqual(["lead", "pip"]);
  });

  it("keeps registration order when an agent leaves a team and rejoins it", () => {
    const emit = eventStream();
    const state = run([
      emit("team.started", { teamId: "t1", leadAgentId: "lead" }),
      registered(emit, "lead", "lead", { teamId: "t1" }),
      registered(emit, "pip", "teammate", { teamId: "t1" }),
      registered(emit, "bo", "teammate", { teamId: "t1" }),
      registered(emit, "pip", "teammate", { teamId: "t2" }),
      registered(emit, "pip", "teammate", { teamId: "t1" }),
    ]);
    expect(state.teams.t1?.memberAgentIds).toEqual(["lead", "pip", "bo"]);
  });

  it("moves an agent between teams and ends a team without dropping members", () => {
    const emit = eventStream();
    const state = run([
      emit("team.started", { teamId: "t1", leadAgentId: "l1" }),
      emit("team.started", { teamId: "t2", leadAgentId: "l2" }),
      registered(emit, "pip", "teammate", { teamId: "t1" }),
      registered(emit, "pip", "teammate", { teamId: "t2" }),
      emit("team.ended", { teamId: "t2" }),
    ]);
    expect(state.teams.t1?.memberAgentIds).toEqual([]);
    expect(state.teams.t2).toMatchObject({
      memberAgentIds: ["pip"],
      endedAt: "2026-10-30T10:00:05Z",
    });
  });

  it("keeps in-process teammates as their own agents inside the lead's session", () => {
    // S-2: in-process teammates share the lead's session_id but have their own agent_id.
    const emit = eventStream();
    const state = run([
      registered(emit, "lead", "lead", { teamId: "team1" }),
      emit("session.started", {}, { agentId: "lead", sessionId: "s-lead" }),
      registered(emit, "pip", "teammate", { teamId: "team1" }),
      emit("activity.started", { activity: "testing" }, { agentId: "pip", sessionId: "s-lead" }),
    ]);
    expect(state.sessions["s-lead"]?.agentId).toBe("lead");
    expect(state.activity.pip).toMatchObject({ activity: "testing", openSessionCount: 0 });
    expect(state.activity.pip?.sessionId).toBeUndefined();
    expect(state.activity.lead).toMatchObject({ activity: "unknown", sessionId: "s-lead" });
  });
});

describe("sessions and activity", () => {
  it("starts with unknown activity until a source reports one", () => {
    const emit = eventStream();
    const state = run([registered(emit, "a1", "session")]);
    expect(state.activity.a1).toEqual({
      agentId: "a1",
      activity: "unknown",
      heuristic: false,
      since: "2026-10-30T10:00:01Z",
      openSessionCount: 0,
    });
  });

  it("allows several open sessions and shows the most recently started one", () => {
    const emit = eventStream();
    const events = [
      registered(emit, "a1", "session"),
      emit("session.started", { workingDirectory: "/w/one" }, { agentId: "a1", sessionId: "s1" }),
      emit("activity.started", { activity: "testing" }, { agentId: "a1", sessionId: "s1" }),
      emit("session.started", {}, { agentId: "a1", sessionId: "s2" }),
      emit(
        "activity.started",
        { activity: "researching", heuristic: true },
        { agentId: "a1", sessionId: "s2" },
      ),
    ];
    const both = run(events);
    expect(both.sessions.s1).toMatchObject({
      agentId: "a1",
      sourceId: "test",
      provenance: "live",
      workingDirectory: "/w/one",
      startedAt: "2026-10-30T10:00:02Z",
    });
    expect(both.activity.a1).toEqual({
      agentId: "a1",
      sessionId: "s2",
      activity: "researching",
      heuristic: true,
      since: "2026-10-30T10:00:05Z",
      openSessionCount: 2,
    });

    // Ending the primary session falls back to the other open one.
    const ended = run([...events, emit("session.ended", {}, { agentId: "a1", sessionId: "s2" })]);
    expect(ended.sessions.s2?.endedAt).toBe("2026-10-30T10:00:06Z");
    expect(ended.activity.a1).toMatchObject({
      sessionId: "s1",
      activity: "testing",
      since: "2026-10-30T10:00:03Z",
      openSessionCount: 1,
    });

    // Activity in the older session updates that session but not the primary view.
    const older = run([
      ...events,
      emit("activity.started", { activity: "documenting" }, { agentId: "a1", sessionId: "s1" }),
    ]);
    expect(older.sessions.s1?.activity.activity).toBe("documenting");
    expect(older.activity.a1?.activity).toBe("researching");
  });

  it("goes idle when the agent's last open session ends", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "a1", "session"),
      emit("session.started", {}, { agentId: "a1", sessionId: "s1" }),
      emit("activity.started", { activity: "testing" }, { agentId: "a1", sessionId: "s1" }),
      emit("session.ended", { outcome: "exit" }, { agentId: "a1", sessionId: "s1" }),
    ]);
    expect(state.activity.a1).toEqual({
      agentId: "a1",
      activity: "idle",
      heuristic: false,
      since: "2026-10-30T10:00:04Z",
      openSessionCount: 0,
    });
  });

  it("applies activity without a session to the primary session, or to the agent if none", () => {
    const emit = eventStream();
    const noSession = run([
      registered(emit, "a1", "session"),
      emit("activity.started", { activity: "dispatching" }, { agentId: "a1" }),
    ]);
    expect(noSession.activity.a1).toMatchObject({ activity: "dispatching", openSessionCount: 0 });

    const emit2 = eventStream();
    const withSession = run([
      registered(emit2, "a1", "session"),
      emit2("session.started", {}, { agentId: "a1", sessionId: "s1" }),
      emit2("activity.started", { activity: "dispatching" }, { agentId: "a1" }),
      emit2("activity.ended", {}, { agentId: "a1", sessionId: "s1" }),
    ]);
    expect(withSession.sessions.s1?.activity).toEqual({
      activity: "idle",
      heuristic: false,
      since: "2026-10-30T10:00:04Z",
    });
    expect(withSession.activity.a1).toMatchObject({ activity: "idle", sessionId: "s1" });
  });

  it("keeps an unrecognized activity as unknown with the original value", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "a1", "session"),
      emit(
        "activity.started",
        { activity: "unknown", sourceValue: "pondering" },
        { agentId: "a1" },
      ),
    ]);
    expect(state.activity.a1).toMatchObject({ activity: "unknown", sourceValue: "pondering" });
  });

  it("creates a session it first hears about from a turn event, without inventing a start time", () => {
    const emit = eventStream();
    const state = run([emit("session.turn_ended", {}, { agentId: "a1", sessionId: "s1" })]);
    expect(state.sessions.s1).toEqual({
      id: "s1",
      agentId: "a1",
      sourceId: "test",
      provenance: "live",
      firstSeenAt: "2026-10-30T10:00:01Z",
      startSeq: 1,
      activity: { activity: "unknown", heuristic: false, since: "2026-10-30T10:00:01Z" },
    });
    expect(state.activity.a1?.openSessionCount).toBe(1);
  });

  it("never lets one agent end or start another agent's session", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, { agentId: "a1", sessionId: "s1" }),
      emit("session.ended", {}, { agentId: "a2", sessionId: "s1" }),
      emit("session.started", { workingDirectory: "/x" }, { agentId: "a2", sessionId: "s1" }),
    ]);
    expect(state.sessions.s1).toMatchObject({ agentId: "a1" });
    expect(state.sessions.s1?.endedAt).toBeUndefined();
    expect(state.sessions.s1?.workingDirectory).toBeUndefined();
  });

  it("picks the primary session by start time, not by when Taskville first heard of it", () => {
    const emit = eventStream();
    const state = run([
      // s1 is first heard of through a turn event; its start arrives late (async hooks race).
      emit("session.turn_ended", {}, { agentId: "a1", sessionId: "s1" }),
      emit("session.started", {}, { agentId: "a1", sessionId: "s2" }),
      emit(
        "session.started",
        {},
        { agentId: "a1", sessionId: "s1", occurredAt: "2026-10-30T09:00:00Z" },
      ),
    ]);
    expect(state.sessions.s1?.startedAt).toBe("2026-10-30T09:00:00Z");
    expect(state.activity.a1?.sessionId).toBe("s2");

    const emit2 = eventStream();
    const later = run([
      emit2("session.turn_ended", {}, { agentId: "a1", sessionId: "s1" }),
      emit2("session.started", {}, { agentId: "a1", sessionId: "s2" }),
      // s1's start is reported as later than s2's, so s1 becomes primary.
      emit2(
        "session.started",
        {},
        { agentId: "a1", sessionId: "s1", occurredAt: "2026-10-30T11:00:00Z" },
      ),
    ]);
    expect(later.activity.a1?.sessionId).toBe("s1");
  });

  it("does not reopen a session when a late start is older than its end", () => {
    const emit = eventStream();
    const state = run([
      emit("session.ended", {}, { agentId: "a1", sessionId: "s1" }),
      emit(
        "session.started",
        {},
        { agentId: "a1", sessionId: "s1", occurredAt: "2026-10-30T09:00:00Z" },
      ),
    ]);
    expect(state.sessions.s1).toMatchObject({
      startedAt: "2026-10-30T09:00:00Z",
      endedAt: "2026-10-30T10:00:01Z",
    });
    expect(state.activity.a1?.openSessionCount).toBe(0);
  });

  it("records activity for a session it has not heard of in that session, not another", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, { agentId: "a1", sessionId: "s1" }),
      emit("activity.started", { activity: "testing" }, { agentId: "a1", sessionId: "s1" }),
      emit("activity.started", { activity: "documenting" }, { agentId: "a1", sessionId: "s2" }),
    ]);
    expect(state.sessions.s1?.activity.activity).toBe("testing");
    expect(state.sessions.s2).toMatchObject({
      agentId: "a1",
      activity: { activity: "documenting" },
    });
    expect(state.sessions.s2?.startedAt).toBeUndefined();
    expect(state.activity.a1?.openSessionCount).toBe(2);
  });

  it("never writes one agent's activity into another agent's session", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, { agentId: "a1", sessionId: "s1" }),
      emit("session.started", {}, { agentId: "a2", sessionId: "s2" }),
      emit("activity.started", { activity: "testing" }, { agentId: "a2", sessionId: "s1" }),
    ]);
    expect(state.sessions.s1?.activity.activity).toBe("unknown");
    expect(state.sessions.s2?.activity.activity).toBe("unknown");
  });

  it("reopens an ended session when it starts again", () => {
    const emit = eventStream();
    const state = run([
      emit("session.started", {}, { agentId: "a1", sessionId: "s1" }),
      emit("session.ended", {}, { agentId: "a1", sessionId: "s1" }),
      emit("session.started", {}, { agentId: "a1", sessionId: "s1" }),
    ]);
    expect(state.sessions.s1?.endedAt).toBeUndefined();
    expect(state.sessions.s1?.startedAt).toBe("2026-10-30T10:00:03Z");
    expect(state.activity.a1?.openSessionCount).toBe(1);
  });

  it("records the latest test result as evidence on the agent's activity", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "a1", "session"),
      emit("test.result", { passed: 3, failed: 1, skipped: 0, summary: "x" }, { agentId: "a1" }),
      emit("session.started", {}, { agentId: "a1", sessionId: "s1" }),
    ]);
    expect(state.activity.a1?.latestEvidence).toEqual({
      kind: "test_result",
      eventId: "00000000-0000-4000-8000-000000000002",
      at: "2026-10-30T10:00:02Z",
      passed: 3,
      failed: 1,
      skipped: 0,
    });
  });
});

describe("turns", () => {
  it("records the latest turn event and clears it per the attention rules", () => {
    const emit = eventStream();
    const base = [registered(emit, "a1", "session")];
    const s = { agentId: "a1", sessionId: "s1" };
    const ended = run([...base, emit("session.turn_ended", {}, s)]);
    expect(ended.agents.a1).toMatchObject({
      lastTurn: "ended",
      lastTurnAt: "2026-10-30T10:00:02Z",
    });

    const failed = [...base, emit("session.turn_failed", { reason: reason("api error") }, s)];
    expect(run(failed).agents.a1?.lastTurn).toBe("failed");
    // A tool call starting or failing does not clear a failed turn; a success does.
    const stillFailed = run([
      ...failed,
      emit("tool_call.started", { toolCallId: "t1", toolName: "Bash" }, s),
      emit("tool_call.finished", { toolCallId: "t1", phase: "failed" }, s),
    ]);
    expect(stillFailed.agents.a1?.lastTurn).toBe("failed");
    const recovered = run([
      ...failed,
      emit("tool_call.started", { toolCallId: "t2", toolName: "Bash" }, s),
      emit("tool_call.finished", { toolCallId: "t2", phase: "succeeded" }, s),
    ]);
    expect(recovered.agents.a1?.lastTurn).toBeUndefined();
    expect(recovered.agents.a1?.lastTurnAt).toBeUndefined();

    const idle = [...base, emit("session.idle_prompt", {}, s)];
    expect(run(idle).agents.a1?.lastTurn).toBe("idle_prompt");
    const toolCall = run([
      ...idle,
      emit("tool_call.started", { toolCallId: "t3", toolName: "Read" }, s),
    ]);
    expect(toolCall.agents.a1?.lastTurn).toBeUndefined();
    const prompt = run([...failed, emit("session.prompt_submitted", {}, s)]);
    expect(prompt.agents.a1?.lastTurn).toBeUndefined();
  });
});

describe("tasks", () => {
  it("creates a queued task and assigns agents in assignment order", () => {
    const emit = eventStream();
    const state = run([
      emit("task.created", { title: "Parse config", relatedTaskIds: ["k0"] }, { taskId: "k1" }),
      emit("task.assigned", { agentIds: ["b", "a"] }, { taskId: "k1" }),
      emit("task.assigned", { agentIds: ["a", "c"] }, { taskId: "k1" }),
    ]);
    expect(state.tasks.k1).toEqual({
      id: "k1",
      title: "Parse config",
      status: "assigned",
      assignedAgentIds: ["b", "a", "c"],
      relatedTaskIds: ["k0"],
      createdAt: "2026-10-30T10:00:01Z",
      updatedAt: "2026-10-30T10:00:03Z",
    });
  });

  it("follows the state graph without warnings", () => {
    const emit = eventStream();
    const status = (s: "running" | "blocked" | "awaiting_input" | "reviewing" | "completed") =>
      emit("task.status_changed", { status: s }, { taskId: "k1" });
    const state = run([
      emit("task.created", { title: "t" }, { taskId: "k1" }),
      emit("task.assigned", { agentIds: ["a"] }, { taskId: "k1" }),
      status("running"),
      status("blocked"),
      status("running"),
      status("awaiting_input"),
      status("running"),
      status("reviewing"),
      status("running"),
      status("reviewing"),
      status("completed"),
    ]);
    expect(state.tasks.k1?.status).toBe("completed");
    expect(state.tasks.k1?.transitionWarning).toBeUndefined();
  });

  it("applies but flags transitions outside the graph, including leaving a terminal status", () => {
    const emit = eventStream();
    const skip = run([
      emit("task.created", { title: "t" }, { taskId: "k1" }),
      emit("task.status_changed", { status: "completed" }, { taskId: "k1" }),
    ]);
    expect(skip.tasks.k1).toMatchObject({
      status: "completed",
      transitionWarning: { from: "queued", to: "completed", at: "2026-10-30T10:00:02Z" },
    });

    const emit2 = eventStream();
    const reopened = run([
      emit2("task.created", { title: "t" }, { taskId: "k1" }),
      emit2("task.status_changed", { status: "cancelled" }, { taskId: "k1" }),
      emit2("task.assigned", { agentIds: ["a"] }, { taskId: "k1" }),
    ]);
    expect(reopened.tasks.k1).toMatchObject({
      status: "assigned",
      transitionWarning: { from: "cancelled", to: "assigned" },
    });
  });

  it("allows any non-terminal status to fail, be cancelled, or become unknown", () => {
    for (const to of ["failed", "cancelled", "unknown"] as const) {
      const emit = eventStream();
      const state = run([
        emit("task.created", { title: "t" }, { taskId: "k1" }),
        emit("task.status_changed", { status: to }, { taskId: "k1" }),
      ]);
      expect(state.tasks.k1?.status).toBe(to);
      expect(state.tasks.k1?.transitionWarning).toBeUndefined();
    }
  });

  it("keeps an unrecognized status as unknown with the original, and clears it on a known one", () => {
    const emit = eventStream();
    const events = [
      emit("task.created", { title: "t" }, { taskId: "k1" }),
      emit("task.status_changed", { status: "unknown", sourceValue: "parked" }, { taskId: "k1" }),
    ];
    expect(run(events).tasks.k1).toMatchObject({ status: "unknown", sourceValue: "parked" });
    const later = run([
      ...events,
      emit("task.status_changed", { status: "failed" }, { taskId: "k1" }),
    ]);
    expect(later.tasks.k1?.status).toBe("failed");
    expect(later.tasks.k1?.sourceValue).toBeUndefined();
  });

  it("does not warn when a status is reported again", () => {
    const emit = eventStream();
    const state = run([
      emit("task.created", { title: "t" }, { taskId: "k1" }),
      emit("task.status_changed", { status: "queued" }, { taskId: "k1" }),
    ]);
    expect(state.tasks.k1?.transitionWarning).toBeUndefined();
  });

  it("creates a task it first hears about from a later event, without inventing a title", () => {
    const emit = eventStream();
    const state = run([
      emit("task.status_changed", { status: "running" }, { taskId: "k1" }),
      emit("task.created", { title: "Late title" }, { taskId: "k1" }),
    ]);
    expect(state.tasks.k1).toEqual({
      id: "k1",
      title: "Late title",
      status: "running",
      assignedAgentIds: [],
      relatedTaskIds: [],
      createdAt: "2026-10-30T10:00:02Z",
      updatedAt: "2026-10-30T10:00:02Z",
    });
  });

  it("marks a sender handing_off even when the handoff is the first event naming it", () => {
    const emit = eventStream();
    const state = run([
      emit("task.handoff", { fromAgentId: "lead", toAgentId: "pip" }, { taskId: "k1" }),
    ]);
    expect(state.agents.lead).toMatchObject({ registered: false, kind: "unknown" });
    expect(state.activity.lead).toMatchObject({ activity: "handing_off", taskId: "k1" });
    expect(state.agents.pip).toBeUndefined();
  });

  it("hands a task off: reassigns it and marks the sender handing_off", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "lead", "lead"),
      registered(emit, "pip", "teammate"),
      emit("task.created", { title: "t" }, { taskId: "k1" }),
      emit("task.assigned", { agentIds: ["lead"] }, { taskId: "k1" }),
      emit("task.status_changed", { status: "running" }, { taskId: "k1" }),
      emit(
        "task.handoff",
        { fromAgentId: "lead", toAgentId: "pip", note: "yours" },
        { taskId: "k1" },
      ),
    ]);
    expect(state.tasks.k1).toMatchObject({ status: "running", assignedAgentIds: ["pip"] });
    expect(state.activity.lead).toMatchObject({
      activity: "handing_off",
      taskId: "k1",
      since: "2026-10-30T10:00:06Z",
    });
    expect(state.activity.pip?.activity).toBe("unknown");
  });
});

describe("tool calls", () => {
  it("opens and closes a tool call and keeps counters", () => {
    const emit = eventStream();
    const state = run([
      registered(emit, "a1", "session"),
      emit(
        "tool_call.started",
        { toolCallId: "t1", toolName: "Edit", filePaths: ["src/a.ts"], summary: "edit a" },
        { agentId: "a1", sessionId: "s1", evidenceIds: ["ev1"] },
      ),
    ]);
    expect(state.toolCalls.t1).toEqual({
      id: "t1",
      agentId: "a1",
      sessionId: "s1",
      toolName: "Edit",
      phase: "running",
      filePaths: ["src/a.ts"],
      summary: "edit a",
      evidenceIds: ["ev1"],
      startedAt: "2026-10-30T10:00:02Z",
      startSeq: 2,
    });
    expect(state.agents.a1?.toolCallCount).toBe(1);

    const finished = reduce(
      state,
      emit(
        "tool_call.finished",
        { toolCallId: "t1", phase: "succeeded", durationMs: 40 },
        { agentId: "a1", evidenceIds: ["ev2", "ev1"] },
      ),
    );
    expect(finished.toolCalls.t1).toMatchObject({
      phase: "succeeded",
      durationMs: 40,
      finishedAt: "2026-10-30T10:00:03Z",
      evidenceIds: ["ev1", "ev2"],
      summary: "edit a",
    });
  });

  it("counts consecutive failures and resets on success", () => {
    const emit = eventStream();
    const events: StoredEnvelope[] = [registered(emit, "a1", "session")];
    for (const [i, phase] of (["failed", "failed", "failed"] as const).entries()) {
      events.push(
        emit("tool_call.started", { toolCallId: `t${i}`, toolName: "Bash" }, { agentId: "a1" }),
        emit("tool_call.finished", { toolCallId: `t${i}`, phase }, { agentId: "a1" }),
      );
    }
    expect(run(events).agents.a1).toMatchObject({ consecutiveToolFailures: 3, toolCallCount: 3 });
    events.push(
      emit("tool_call.started", { toolCallId: "ok", toolName: "Bash" }, { agentId: "a1" }),
      emit("tool_call.finished", { toolCallId: "ok", phase: "succeeded" }, { agentId: "a1" }),
    );
    expect(run(events).agents.a1).toMatchObject({ consecutiveToolFailures: 0, toolCallCount: 4 });
  });

  it("keeps only open calls plus the latest finished call per agent", () => {
    const emit = eventStream();
    const state = run([
      emit("tool_call.started", { toolCallId: "a-1", toolName: "Read" }, { agentId: "a" }),
      emit("tool_call.started", { toolCallId: "a-2", toolName: "Read" }, { agentId: "a" }),
      emit("tool_call.started", { toolCallId: "a-3", toolName: "Read" }, { agentId: "a" }),
      emit("tool_call.started", { toolCallId: "b-1", toolName: "Read" }, { agentId: "b" }),
      emit("tool_call.finished", { toolCallId: "a-1", phase: "succeeded" }, { agentId: "a" }),
      emit("tool_call.finished", { toolCallId: "b-1", phase: "succeeded" }, { agentId: "b" }),
      emit("tool_call.finished", { toolCallId: "a-2", phase: "failed" }, { agentId: "a" }),
    ]);
    expect(Object.keys(state.toolCalls).sort()).toEqual(["a-2", "a-3", "b-1"]);
    expect(state.agents.a?.toolCallCount).toBe(3);
  });

  it("caps open calls per agent, dropping the oldest from the projection", () => {
    const emit = eventStream();
    const events: StoredEnvelope[] = [];
    for (let i = 0; i < MAX_OPEN_TOOL_CALLS_PER_AGENT + 5; i++) {
      events.push(
        emit("tool_call.started", { toolCallId: `t${i}`, toolName: "Bash" }, { agentId: "a" }),
      );
    }
    const state = run(events);
    const ids = Object.keys(state.toolCalls);
    expect(ids).toHaveLength(MAX_OPEN_TOOL_CALLS_PER_AGENT);
    expect(ids).not.toContain("t0");
    expect(ids).toContain(`t${MAX_OPEN_TOOL_CALLS_PER_AGENT + 4}`);
    expect(state.agents.a?.toolCallCount).toBe(MAX_OPEN_TOOL_CALLS_PER_AGENT + 5);
  });

  it("records a finish whose start was never seen without inventing a name or start", () => {
    const emit = eventStream();
    const state = run([
      emit(
        "tool_call.finished",
        { toolCallId: "t1", phase: "failed", durationMs: 26 },
        { agentId: "a" },
      ),
    ]);
    expect(state.toolCalls.t1).toEqual({
      id: "t1",
      agentId: "a",
      phase: "failed",
      filePaths: [],
      evidenceIds: [],
      finishedAt: "2026-10-30T10:00:01Z",
      durationMs: 26,
      startSeq: 1,
    });
    // Counted when its start arrives, not before (a start may still come; see below).
    expect(state.agents.a).toMatchObject({ toolCallCount: 0, consecutiveToolFailures: 1 });
  });

  it("fills in a finish-first call when its start arrives late, counting it once", () => {
    const emit = eventStream();
    const state = run([
      emit("tool_call.finished", { toolCallId: "t1", phase: "succeeded" }, { agentId: "a" }),
      emit(
        "tool_call.started",
        { toolCallId: "t1", toolName: "Edit", filePaths: ["a.ts"], summary: "s" },
        { agentId: "a", evidenceIds: ["ev1"] },
      ),
    ]);
    expect(state.toolCalls.t1).toEqual({
      id: "t1",
      agentId: "a",
      toolName: "Edit",
      phase: "succeeded",
      filePaths: ["a.ts"],
      summary: "s",
      evidenceIds: ["ev1"],
      startedAt: "2026-10-30T10:00:02Z",
      finishedAt: "2026-10-30T10:00:01Z",
      startSeq: 1,
    });
    expect(state.agents.a?.toolCallCount).toBe(1);
  });

  it("does not count a call twice when it finishes after being dropped from the projection", () => {
    const emit = eventStream();
    const events: StoredEnvelope[] = [];
    for (let i = 0; i <= MAX_OPEN_TOOL_CALLS_PER_AGENT; i++) {
      events.push(
        emit("tool_call.started", { toolCallId: `t${i}`, toolName: "Bash" }, { agentId: "a" }),
      );
    }
    events.push(
      emit("tool_call.finished", { toolCallId: "t0", phase: "succeeded" }, { agentId: "a" }),
    );
    const state = run(events);
    expect(state.toolCalls.t0?.phase).toBe("succeeded");
    expect(state.agents.a?.toolCallCount).toBe(MAX_OPEN_TOOL_CALLS_PER_AGENT + 1);
  });

  it("ignores a start or finish from another agent for a call it does not own", () => {
    const emit = eventStream();
    const state = run([
      emit("tool_call.started", { toolCallId: "t1", toolName: "Bash" }, { agentId: "a" }),
      emit("tool_call.finished", { toolCallId: "t1", phase: "failed" }, { agentId: "b" }),
      emit("tool_call.finished", { toolCallId: "t2", phase: "failed" }, { agentId: "a" }),
      emit("tool_call.started", { toolCallId: "t2", toolName: "Edit" }, { agentId: "b" }),
    ]);
    expect(state.toolCalls.t1).toMatchObject({ agentId: "a", phase: "running" });
    expect(state.toolCalls.t2).toMatchObject({ agentId: "a", phase: "failed" });
    expect(state.toolCalls.t2?.toolName).toBeUndefined();
    expect(state.agents.a).toMatchObject({ toolCallCount: 1, consecutiveToolFailures: 1 });
    expect(state.agents.b).toMatchObject({ toolCallCount: 0, consecutiveToolFailures: 0 });
  });

  it("ignores a repeated start or finish for the same call", () => {
    const emit = eventStream();
    const state = run([
      emit("tool_call.started", { toolCallId: "t1", toolName: "Bash" }, { agentId: "a" }),
      emit("tool_call.started", { toolCallId: "t1", toolName: "Bash" }, { agentId: "a" }),
      emit("tool_call.finished", { toolCallId: "t1", phase: "failed" }, { agentId: "a" }),
      emit("tool_call.finished", { toolCallId: "t1", phase: "failed" }, { agentId: "a" }),
    ]);
    expect(state.agents.a).toMatchObject({ toolCallCount: 1, consecutiveToolFailures: 1 });
  });
});
