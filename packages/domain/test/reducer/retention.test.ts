import type { StoredEnvelope } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import {
  type ProjectState,
  projectStateHash,
  RETAIN_CLOSED_REQUESTS,
  RETAIN_FINISHED_AGENTS,
  RETAIN_TERMINAL_TASKS,
  reduce,
  replay,
} from "../../src/reducer/index.ts";
import { type Emit, eventStream } from "./events.ts";

// M2.16 (#167, decision #202 D1 default): data-model.md "Retention". Closed and finished
// records stay in the projection only while they are among the newest; `retired` counts the rest.

const run = (events: StoredEnvelope[]): ProjectState => replay("p1", events);
const ENGINE = "taskville:engine";

const subagent = (emit: Emit, id: string, parent = "lead") =>
  emit(
    "agent.registered",
    { sourceAgentId: id, displayName: id, role: "dev", kind: "subagent", parentAgentId: parent },
    { agentId: id },
  );
const finished = (emit: Emit, id: string) => emit("agent.finished", {}, { agentId: id });

/** `n` subagents of the lead, each registered then finished, in order. */
function finishedSubagents(emit: Emit, n: number, prefix = "sub"): StoredEnvelope[] {
  const events: StoredEnvelope[] = [];
  for (let i = 0; i < n; i += 1) {
    const id = `${prefix}-${String(i).padStart(3, "0")}`;
    events.push(
      subagent(emit, id),
      emit("activity.started", { activity: "implementing" }, { agentId: id }),
    );
    events.push(finished(emit, id));
  }
  return events;
}

describe("finished agents", () => {
  it("keeps the newest finished agents and counts the dropped ones", () => {
    const emit = eventStream();
    const state = run([
      emit(
        "agent.registered",
        { sourceAgentId: "lead", displayName: "lead", role: "main", kind: "session" },
        { agentId: "lead" },
      ),
      ...finishedSubagents(emit, RETAIN_FINISHED_AGENTS + 3),
    ]);
    const kept = Object.values(state.agents).filter((a) => a.finishedAt !== undefined);
    expect(kept).toHaveLength(RETAIN_FINISHED_AGENTS);
    expect(state.agents["sub-000"]).toBeUndefined();
    expect(state.agents["sub-002"]).toBeUndefined();
    expect(state.agents["sub-003"]).toBeDefined();
    expect(state.activity["sub-000"]).toBeUndefined();
    expect(state.agents.lead).toBeDefined();
    expect(state.retired).toEqual({ agents: 3, tasks: 0, requests: 0 });
  });

  it("stays bounded over a long run", () => {
    const emit = eventStream();
    const state = run(finishedSubagents(emit, 500));
    expect(Object.keys(state.agents)).toHaveLength(RETAIN_FINISHED_AGENTS);
    expect(Object.keys(state.activity)).toHaveLength(RETAIN_FINISHED_AGENTS);
    expect(state.retired.agents).toBe(500 - RETAIN_FINISHED_AGENTS);
  });

  it("never drops a parent of an unfinished agent, a team lead, an agent with an open request, or one with a running call", () => {
    const emit = eventStream();
    const events: StoredEnvelope[] = [
      subagent(emit, "parent", "root"),
      subagent(emit, "child", "parent"),
      emit(
        "agent.registered",
        { sourceAgentId: "lead", displayName: "lead", role: "main", kind: "lead", teamId: "t1" },
        { agentId: "lead" },
      ),
      emit("team.started", { teamId: "t1", leadAgentId: "lead" }, { agentId: "lead" }),
      subagent(emit, "asker"),
      emit(
        "request.opened",
        { requestId: "r1", kind: "permission" },
        { agentId: "asker", sessionId: "s1" },
      ),
      subagent(emit, "busy"),
      finished(emit, "parent"),
      finished(emit, "lead"),
      finished(emit, "asker"),
      finished(emit, "busy"),
      emit("tool_call.started", { toolCallId: "late-call", toolName: "Bash" }, { agentId: "busy" }),
      ...finishedSubagents(emit, RETAIN_FINISHED_AGENTS + 5),
    ];
    const state = run(events);
    for (const id of ["parent", "child", "lead", "asker", "busy"])
      expect(state.agents[id]).toBeDefined();
    expect(state.retired.agents).toBe(5);
  });

  it("drops a protected agent once the protection ends", () => {
    const emit = eventStream();
    const base = [
      subagent(emit, "parent", "root"),
      subagent(emit, "child", "parent"),
      finished(emit, "parent"),
      ...finishedSubagents(emit, RETAIN_FINISHED_AGENTS),
    ];
    expect(run(base).agents.parent).toBeDefined();
    const after = run([...base, finished(emit, "child")]);
    expect(after.agents.parent).toBeUndefined();
  });

  it("drops the sessions, tool calls, and team places of a dropped agent", () => {
    const emit = eventStream();
    const events = [
      emit(
        "agent.registered",
        { sourceAgentId: "m", displayName: "m", role: "dev", kind: "teammate", teamId: "t1" },
        { agentId: "m" },
      ),
      emit("team.started", { teamId: "t1", leadAgentId: "boss" }, { agentId: "boss" }),
      emit("session.started", {}, { agentId: "m", sessionId: "s-m" }),
      emit(
        "tool_call.started",
        { toolCallId: "c1", toolName: "Read" },
        { agentId: "m", sessionId: "s-m" },
      ),
      emit(
        "tool_call.finished",
        { toolCallId: "c1", phase: "succeeded" },
        { agentId: "m", sessionId: "s-m" },
      ),
      finished(emit, "m"),
      ...finishedSubagents(emit, RETAIN_FINISHED_AGENTS),
    ];
    const state = run(events);
    expect(state.agents.m).toBeUndefined();
    expect(state.sessions["s-m"]).toBeUndefined();
    expect(state.toolCalls.c1).toBeUndefined();
    expect(state.teams.t1?.memberAgentIds).not.toContain("m");
  });

  it("applies a later event for a dropped agent like one for an unseen agent", () => {
    const emit = eventStream();
    const events = [...finishedSubagents(emit, RETAIN_FINISHED_AGENTS + 1)];
    const state = run([...events, emit("agent.connected", {}, { agentId: "sub-000" })]);
    expect(state.agents["sub-000"]).toMatchObject({ registered: false, kind: "unknown" });
    expect(state.retired.agents).toBe(1);
  });
});

describe("terminal tasks", () => {
  const task = (
    emit: Emit,
    id: string,
    status: "completed" | "failed" | "cancelled" | "running",
  ) => [
    emit("task.created", { title: id }, { taskId: id }),
    emit("task.status_changed", { status }, { taskId: id }),
  ];

  it("keeps the newest terminal tasks and every unfinished one", () => {
    const emit = eventStream();
    const events: StoredEnvelope[] = [];
    for (let i = 0; i < 60; i += 1) events.push(...task(emit, `run-${i}`, "running"));
    const statuses = ["completed", "failed", "cancelled"] as const;
    for (let i = 0; i < RETAIN_TERMINAL_TASKS + 6; i += 1) {
      events.push(
        ...task(emit, `done-${String(i).padStart(3, "0")}`, statuses[i % 3] ?? "completed"),
      );
    }
    const state = run(events);
    const terminal = Object.values(state.tasks).filter((t) => t.status !== "running");
    expect(terminal).toHaveLength(RETAIN_TERMINAL_TASKS);
    expect(Object.values(state.tasks).filter((t) => t.status === "running")).toHaveLength(60);
    expect(state.tasks["done-000"]).toBeUndefined();
    expect(state.tasks["done-006"]).toBeDefined();
    expect(state.retired.tasks).toBe(6);
  });
});

describe("closed requests", () => {
  it("keeps the newest closed requests and every open one", () => {
    const emit = eventStream();
    const events: StoredEnvelope[] = [];
    for (let i = 0; i < RETAIN_CLOSED_REQUESTS + 4; i += 1) {
      const id = `r-${String(i).padStart(3, "0")}`;
      events.push(
        emit(
          "request.opened",
          { requestId: id, kind: "input" },
          { agentId: "a1", sessionId: `s-${i}` },
        ),
      );
      events.push(emit("request.expired", { requestId: id }, { sourceId: ENGINE }));
    }
    events.push(
      emit(
        "request.opened",
        { requestId: "still-open", kind: "input" },
        { agentId: "a1", sessionId: "s-x" },
      ),
    );
    const state = run(events);
    const closed = Object.values(state.requests).filter((r) => r.state !== "open");
    expect(closed).toHaveLength(RETAIN_CLOSED_REQUESTS);
    expect(state.requests["r-000"]).toBeUndefined();
    expect(state.requests["still-open"]?.state).toBe("open");
    expect(state.retired.requests).toBe(4);
  });
});

describe("determinism (ARCHITECTURE 14: replay and checkpoint equivalence)", () => {
  it("gives the same stateHash from a full replay and from a JSON checkpoint at any point", () => {
    const emit = eventStream();
    const events = finishedSubagents(emit, RETAIN_FINISHED_AGENTS + 20);
    const full = run(events);
    for (const cut of [1, 37, 100, events.length - 1]) {
      const checkpoint = JSON.parse(JSON.stringify(run(events.slice(0, cut)))) as ProjectState;
      const resumed = events.slice(cut).reduce(reduce, checkpoint);
      expect(projectStateHash(resumed)).toBe(projectStateHash(full));
    }
  });
});
