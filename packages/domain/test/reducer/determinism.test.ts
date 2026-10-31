import {
  ACTIVITIES,
  AGENT_KINDS,
  type EventType,
  type StoredEnvelope,
  type StoredPayload,
  TASK_STATUSES,
} from "@taskville/protocol";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  MAX_OPEN_TOOL_CALLS_PER_AGENT,
  type ProjectState,
  projectStateHash,
  reduce,
  replay,
} from "../../src/reducer/index.ts";
import { deepFreeze, type EnvelopeFields, eventStream } from "./events.ts";

// Property tests over arbitrary, valid event sequences (research R-7, constitution III).
// Small ID pools make collisions, re-registrations, races and prototype-named IDs common.

const agentIds = fc.constantFrom("a1", "a2", "a3", "__proto__", "constructor");
const sessionIds = fc.constantFrom("s1", "s2", "toString");
const taskIds = fc.constantFrom("k1", "k2", "hasOwnProperty");
const toolCallIds = fc.constantFrom("t1", "t2", "t3", "t4");
const teamIds = fc.constantFrom("team1", "team2", "valueOf");
const times = fc.constantFrom(
  "2026-10-30T09:59:00Z",
  "2026-10-30T12:00:00+02:00",
  "2026-10-30T10:00:00.5-01:00",
  "2026-10-30T10:00:00.25Z",
);
const opt = <T>(arb: fc.Arbitrary<T>) => fc.option(arb, { nil: undefined });

interface Spec {
  type: EventType;
  payload: unknown;
  fields: EnvelopeFields;
}

const spec = <T extends EventType>(
  type: T,
  payload: fc.Arbitrary<StoredPayload<T>>,
  fields: fc.Arbitrary<EnvelopeFields>,
): fc.Arbitrary<Spec> =>
  fc.tuple(payload, fields).map(([p, f]) => ({ type, payload: p, fields: f }));

const common = {
  occurredAt: opt(times),
  late: fc.boolean(),
  sourceId: fc.constantFrom("test", "test", "other"),
};
const withAgent = fc.record(
  { agentId: agentIds, sessionId: opt(sessionIds), taskId: opt(taskIds), ...common },
  { requiredKeys: ["agentId"] },
);
const withSession = fc.record(
  { agentId: agentIds, sessionId: sessionIds, ...common },
  { requiredKeys: ["agentId", "sessionId"] },
);
const withTask = fc.record(
  { taskId: taskIds, agentId: opt(agentIds), ...common },
  { requiredKeys: ["taskId"] },
);
const bare = fc.record({ agentId: opt(agentIds), ...common }, { requiredKeys: [] });

const registration = fc
  .record({
    kind: fc.constantFrom(...AGENT_KINDS),
    sourceAgentId: fc.constantFrom("x", "y"),
    displayName: fc.constantFrom("pip", "bo"),
    role: fc.constant("dev"),
    parentAgentId: opt(agentIds),
    teamId: opt(teamIds),
    sourceValue: opt(fc.constant("orchestrator")),
  })
  .map(({ kind, parentAgentId, teamId, sourceValue, ...rest }) => ({
    ...rest,
    kind,
    ...(parentAgentId !== undefined && (kind === "subagent" || kind === "unknown")
      ? { parentAgentId }
      : {}),
    ...(teamId !== undefined && (kind === "lead" || kind === "teammate" || kind === "unknown")
      ? { teamId }
      : {}),
    ...(sourceValue !== undefined && kind === "unknown" ? { sourceValue } : {}),
  }));

const empty = fc.constant({});
const eventSpec: fc.Arbitrary<Spec> = fc.oneof(
  spec("agent.registered", registration, withAgent),
  spec("agent.connected", empty, withAgent),
  spec("agent.disconnected", empty, withAgent),
  spec("agent.finished", fc.constant({ outcome: "done" }), withAgent),
  spec("team.started", fc.record({ teamId: teamIds, leadAgentId: agentIds }), bare),
  spec("team.ended", fc.record({ teamId: teamIds }), bare),
  spec(
    "session.started",
    fc.record({ workingDirectory: opt(fc.constant("/w")) }, { requiredKeys: [] }),
    withSession,
  ),
  spec("session.ended", empty, withSession),
  spec("session.prompt_submitted", empty, withSession),
  spec("session.turn_ended", empty, withSession),
  spec("session.turn_failed", empty, withSession),
  spec("session.idle_prompt", empty, withSession),
  spec(
    "task.created",
    fc.record(
      { title: fc.constant("t"), relatedTaskIds: opt(fc.array(taskIds, { maxLength: 2 })) },
      { requiredKeys: ["title"] },
    ),
    withTask,
  ),
  spec(
    "task.assigned",
    fc.record({ agentIds: fc.array(agentIds, { minLength: 1, maxLength: 3 }) }),
    withTask,
  ),
  spec(
    "task.status_changed",
    fc
      .constantFrom(...TASK_STATUSES)
      .map((status) => (status === "unknown" ? { status, sourceValue: "parked" } : { status })),
    withTask,
  ),
  spec("task.handoff", fc.record({ fromAgentId: agentIds, toAgentId: agentIds }), withTask),
  spec(
    "activity.started",
    fc
      .record(
        { activity: fc.constantFrom(...ACTIVITIES), heuristic: opt(fc.boolean()) },
        { requiredKeys: ["activity"] },
      )
      .map((p) => (p.activity === "unknown" ? { ...p, sourceValue: "pondering" } : p)),
    withAgent,
  ),
  spec("activity.ended", empty, withAgent),
  spec(
    "tool_call.started",
    fc.record(
      {
        toolCallId: toolCallIds,
        toolName: fc.constantFrom("Bash", "Edit"),
        filePaths: opt(fc.constant(["a.ts"])),
      },
      { requiredKeys: ["toolCallId", "toolName"] },
    ),
    withAgent,
  ),
  spec(
    "tool_call.finished",
    fc.record(
      {
        toolCallId: toolCallIds,
        phase: fc.constantFrom("succeeded" as const, "failed" as const),
        durationMs: opt(fc.nat(100)),
      },
      { requiredKeys: ["toolCallId", "phase"] },
    ),
    withAgent,
  ),
  spec(
    "test.result",
    fc.record({ passed: fc.nat(5), failed: fc.nat(5), skipped: fc.nat(5) }),
    bare,
  ),
  spec(
    "request.opened",
    fc.record({ requestId: fc.constantFrom("r1", "r2"), kind: fc.constant("permission" as const) }),
    withAgent,
  ),
  spec("git.commit", fc.constant({ repo: "r", sha: "abcdef1", parents: [] }), bare),
);

const toEvents = (specs: Spec[]): StoredEnvelope[] => {
  const emit = eventStream();
  return specs.map((s) => emit(s.type, s.payload as never, s.fields));
};

const eventsArb = fc.array(eventSpec, { maxLength: 60 }).map(toEvents);

const jsonRoundTrip = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

describe("reducer determinism (fast-check)", () => {
  it("replaying the same events yields the same stateHash", () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        const first = replay("p1", events);
        const second = replay("p1", jsonRoundTrip(events));
        expect(projectStateHash(second)).toBe(projectStateHash(first));
        expect(second).toEqual(first);
      }),
      { numRuns: 300 },
    );
  });

  it("resuming from a stored (JSON) projection gives the same state as a full replay", () => {
    fc.assert(
      fc.property(eventsArb, fc.nat(), (events, cut) => {
        const at = events.length === 0 ? 0 : cut % (events.length + 1);
        const stored = jsonRoundTrip(replay("p1", events.slice(0, at)));
        const resumed = events.slice(at).reduce(reduce, stored);
        expect(projectStateHash(resumed)).toBe(projectStateHash(replay("p1", events)));
      }),
      { numRuns: 300 },
    );
  });

  it("never mutates its inputs", () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        const frozen = events.map((e) => deepFreeze(structuredClone(e)));
        let state = deepFreeze(replay("p1", []));
        for (const event of frozen) state = deepFreeze(reduce(state, event));
        expect(projectStateHash(state)).toBe(projectStateHash(replay("p1", events)));
      }),
      { numRuns: 100 },
    );
  });

  it("keeps its invariants after every event", () => {
    fc.assert(
      fc.property(eventsArb, (events) => {
        let state = replay("p1", []);
        for (const event of events) {
          state = reduce(state, event);
          checkInvariants(state, event);
        }
      }),
      { numRuns: 300 },
    );
  });
});

function checkInvariants(state: ProjectState, event: StoredEnvelope): void {
  expect(state.head).toBe(event.ingestSequence);
  if (event.agentId !== undefined) expect(Object.hasOwn(state.agents, event.agentId)).toBe(true);

  for (const [id, agent] of Object.entries(state.agents)) {
    expect(agent.id).toBe(id);
    expect(Object.hasOwn(state.activity, id)).toBe(true);
    if (agent.kind !== "subagent" && agent.kind !== "unknown") {
      expect(agent.parentAgentId).toBeUndefined();
    }
    if (agent.kind !== "lead" && agent.kind !== "teammate" && agent.kind !== "unknown") {
      expect(agent.teamId).toBeUndefined();
    }
    const calls = Object.values(state.toolCalls).filter((c) => c.agentId === id);
    expect(calls.filter((c) => c.phase !== "running").length).toBeLessThanOrEqual(1);
    expect(calls.filter((c) => c.phase === "running").length).toBeLessThanOrEqual(
      MAX_OPEN_TOOL_CALLS_PER_AGENT,
    );
    const open = Object.values(state.sessions).filter(
      (s) => s.agentId === id && s.endedAt === undefined,
    );
    expect(state.activity[id]?.openSessionCount).toBe(open.length);
  }

  for (const [id, team] of Object.entries(state.teams)) {
    expect(team.id).toBe(id);
    const members = Object.values(state.agents)
      .filter((a) => a.teamId === id)
      .map((a) => a.id)
      .sort();
    expect([...team.memberAgentIds].sort()).toEqual(members);
  }

  for (const [id, task] of Object.entries(state.tasks)) {
    expect(task.id).toBe(id);
    expect(new Set(task.assignedAgentIds).size).toBe(task.assignedAgentIds.length);
    if (task.status !== "unknown") expect(task.sourceValue).toBeUndefined();
  }
}
