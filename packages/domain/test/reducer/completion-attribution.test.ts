import { readFileSync } from "node:fs";
import { mapClaudeCodeHook } from "@taskville/adapters/claude-code";
import {
  parseInputEvent,
  type StoredEnvelope,
  storedEnvelopeSchema,
  TASK_STATUSES,
} from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { type ProjectState, projectStateHash, reduce, replay } from "../../src/reducer/index.ts";
import { deepFreeze, eventStream } from "./events.ts";

const TASK = "claude-code:task:session-b4395a96:1";
const MEMBER = "claude-code:b4395a96-fd40-4c5f-8ea3-c5f447a2e4a7:apip-c669c6801b38dd2a";
const LEAD = "claude-code:b4395a96-fd40-4c5f-8ea3-c5f447a2e4a7";
const json = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** The existing M2.20 fixture contains the recorded lead creation and member completion. */
function mappedTaskEvents(): StoredEnvelope[] {
  const hooks = readFileSync(
    new URL("../../../adapters/test/claude-code/crew/team-task.fixture.jsonl", import.meta.url),
    "utf8",
  )
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line) as { seq: number; input: Record<string, unknown> });
  let sequence = 0;
  return hooks.flatMap(({ seq, input }) => {
    const result = mapClaudeCodeHook(input, {
      projectId: "p1",
      sourceEventId: `recorded-${seq}`,
      receivedAt: "2026-10-31T12:00:00.000Z",
      late: false,
    });
    return result.events.map((event) => {
      sequence += 1;
      const parsed = parseInputEvent(event);
      if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
      return storedEnvelopeSchema.parse({
        ...parsed.event,
        eventId: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
        receivedAt: event.occurredAt,
        ingestSequence: sequence,
      });
    });
  });
}

function completedTask(assigned = false) {
  const emit = eventStream();
  const events: StoredEnvelope[] = [
    emit("task.created", { title: "pip says hi" }, { taskId: TASK }),
  ];
  if (assigned) events.push(emit("task.assigned", { agentIds: [LEAD] }, { taskId: TASK }));
  events.push(
    emit("task.status_changed", { status: "completed" }, { taskId: TASK, agentId: MEMBER }),
  );
  return { emit, state: replay("p1", events), events };
}

describe("M5.16 factual task completion attribution", () => {
  it("retains the real TaskCompleted member actor without inventing an assignment", () => {
    const events = mappedTaskEvents();
    expect(events.map((event) => event.type)).toEqual(["task.created", "task.status_changed"]);
    expect(events[0]).toMatchObject({ taskId: TASK, agentId: LEAD });
    expect(events[1]).toMatchObject({
      taskId: TASK,
      agentId: MEMBER,
      payload: { status: "completed" },
    });
    const state = replay("p1", deepFreeze(events));
    expect(state.tasks[TASK]?.assignedAgentIds).toEqual([]);
    expect(state.tasks[TASK]).toMatchObject({ status: "completed", completedByAgentId: MEMBER });
  });

  it("keeps the recorded completion actor in JSON snapshots and every replay split", () => {
    const events = mappedTaskEvents();
    const full = replay("p1", events);
    const snapshot = json(full);
    expect.soft(snapshot.tasks[TASK]).toMatchObject({
      status: "completed",
      completedByAgentId: MEMBER,
      assignedAgentIds: [],
    });
    for (let cut = 0; cut <= events.length; cut += 1) {
      const stored: ProjectState = json(replay("p1", events.slice(0, cut)));
      const resumed = json(events.slice(cut)).reduce(reduce, deepFreeze(stored));
      expect.soft(resumed.tasks[TASK]).toMatchObject({ completedByAgentId: MEMBER });
      expect(resumed).toEqual(full);
      expect(projectStateHash(resumed)).toBe(projectStateHash(full));
    }
    expect(projectStateHash(snapshot)).toBe(projectStateHash(full));
  });

  it("records the completing actor separately from an existing assignment", () => {
    const { state } = completedTask(true);
    expect(state.tasks[TASK]?.assignedAgentIds).toEqual([LEAD]);
    expect(state.tasks[TASK]).toMatchObject({ completedByAgentId: MEMBER });
  });

  it("leaves attribution absent when the completion has no actor, including after an attributed completion", () => {
    const emit = eventStream();
    const anonymous = emit("task.status_changed", { status: "completed" }, { taskId: TASK });
    const first = replay("p1", [anonymous]);
    expect(first.tasks[TASK]).not.toHaveProperty("completedByAgentId");
    expect(first.tasks[TASK]?.assignedAgentIds).toEqual([]);

    const { emit: next, state } = completedTask(true);
    expect.soft(state.tasks[TASK]).toMatchObject({ completedByAgentId: MEMBER });
    const completed = reduce(
      deepFreeze(state),
      next("task.status_changed", { status: "completed" }, { taskId: TASK }),
    );
    expect(completed.tasks[TASK]).not.toHaveProperty("completedByAgentId");
    expect(completed.tasks[TASK]?.assignedAgentIds).toEqual([LEAD]);
  });

  it.each(TASK_STATUSES.filter((status) => status !== "completed"))(
    "clears completion attribution on a later %s status without changing assignment",
    (status) => {
      const { emit, state } = completedTask(true);
      expect.soft(state.tasks[TASK]).toMatchObject({ completedByAgentId: MEMBER });
      const reopened = reduce(
        deepFreeze(state),
        emit(
          "task.status_changed",
          status === "unknown" ? { status, sourceValue: "parked" } : { status },
          { taskId: TASK, agentId: LEAD },
        ),
      );
      expect(reopened.tasks[TASK]).toMatchObject({ status, assignedAgentIds: [LEAD] });
      expect(reopened.tasks[TASK]).not.toHaveProperty("completedByAgentId");
      expect(json(reopened).tasks[TASK]).not.toHaveProperty("completedByAgentId");
    },
  );
});
