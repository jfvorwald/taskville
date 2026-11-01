import { describe, expect, it } from "vitest";
import { dispatchQueue, teamProgress } from "../../../../src/city/crew/teams/queue.ts";

// ARCHITECTURE 2.9: the team's shared task list (TaskCreated and TaskCompleted hooks, mapped to
// task.created / task.assigned / task.status_changed) is the Dispatch building's queue. The queue
// shows only what was recorded (constitution IV): no invented titles, owners or tasks.
//
// A team task is a task whose id carries the team's scope (`<src>:team:<scope>` owns
// `<src>:task:<scope>:<n>`, the relation M2.20 pins) or one assigned to a member of the team.

const TEAM = "claude-code:team:session-b4395a96";
const OTHER_TEAM = "claude-code:team:session-0d2f9c11";
const task = (n: number, scope = "session-b4395a96") => `claude-code:task:${scope}:${n}`;

interface TaskInput {
  id: string;
  title?: string;
  status: string;
  assignedAgentIds?: string[];
  createdAt?: string;
}

function state(tasks: TaskInput[], extra: { members?: string[] } = {}) {
  return {
    teams: {
      [TEAM]: {
        id: TEAM,
        leadAgentId: "lead",
        memberAgentIds: extra.members ?? ["mate-pip", "mate-bo"],
        startedAt: "2026-11-01T10:00:00.000Z",
      },
      [OTHER_TEAM]: {
        id: OTHER_TEAM,
        leadAgentId: "lead-2",
        memberAgentIds: ["mate-zed"],
        startedAt: "2026-11-01T10:00:00.000Z",
      },
    },
    tasks: Object.fromEntries(
      tasks.map((t) => [
        t.id,
        {
          id: t.id,
          status: t.status,
          assignedAgentIds: t.assignedAgentIds ?? [],
          relatedTaskIds: [],
          updatedAt: "2026-11-01T10:00:00.000Z",
          ...(t.title === undefined ? {} : { title: t.title }),
          ...(t.createdAt === undefined ? {} : { createdAt: t.createdAt }),
        },
      ]),
    ),
  } as never;
}

describe("dispatchQueue", () => {
  it("is empty for a team with no recorded tasks, and for an unknown team", () => {
    expect(dispatchQueue(state([]), TEAM)).toEqual([]);
    expect(dispatchQueue(state([]), "claude-code:team:nope")).toEqual([]);
  });

  it("lists a queued team task as pending with its recorded title", () => {
    const q = dispatchQueue(
      state([{ id: task(1), title: "Write the parser", status: "queued" }]),
      TEAM,
    );
    expect(q).toHaveLength(1);
    expect(q[0]).toMatchObject({
      taskId: task(1),
      title: "Write the parser",
      state: "pending",
      claimedBy: [],
    });
  });

  it("shows a task assigned to a teammate as claimed, by that teammate", () => {
    const q = dispatchQueue(
      state([{ id: task(1), title: "t", status: "assigned", assignedAgentIds: ["mate-pip"] }]),
      TEAM,
    );
    expect(q[0]).toMatchObject({ state: "claimed", claimedBy: ["mate-pip"] });
  });

  it("keeps a running task claimed", () => {
    const q = dispatchQueue(
      state([{ id: task(1), title: "t", status: "running", assignedAgentIds: ["mate-bo"] }]),
      TEAM,
    );
    expect(q[0]).toMatchObject({ state: "claimed", claimedBy: ["mate-bo"] });
  });

  it("does not invent a claimer: a running task with no recorded assignee has none", () => {
    const q = dispatchQueue(state([{ id: task(1), title: "t", status: "running" }]), TEAM);
    expect(q[0]).toMatchObject({ state: "claimed", claimedBy: [] });
  });

  it("shows a completed task as completed", () => {
    const q = dispatchQueue(
      state([{ id: task(1), title: "t", status: "completed", assignedAgentIds: ["mate-pip"] }]),
      TEAM,
    );
    expect(q[0]).toMatchObject({ state: "completed" });
  });

  it("keeps an unknown status visible as unknown, never as pending", () => {
    const q = dispatchQueue(state([{ id: task(1), title: "t", status: "unknown" }]), TEAM);
    expect(q[0]).toMatchObject({ state: "unknown" });
  });

  it("does not invent a title for a task whose task.created never arrived", () => {
    const q = dispatchQueue(state([{ id: task(1), status: "completed" }]), TEAM);
    expect(q[0]?.title).toBeUndefined();
  });

  it("leaves out another team's tasks and tasks that belong to no team", () => {
    const q = dispatchQueue(
      state([
        { id: task(1), title: "mine", status: "queued" },
        { id: task(1, "session-0d2f9c11"), title: "theirs", status: "queued" },
        { id: "claude-code:task:solo:9", title: "solo", status: "queued" },
        { id: "demo:task:3", title: "demo", status: "queued", assignedAgentIds: ["someone"] },
      ]),
      TEAM,
    );
    expect(q.map((e) => e.taskId)).toEqual([task(1)]);
  });

  it("includes a task assigned to a member of the team even when its id carries no scope", () => {
    const q = dispatchQueue(
      state([
        { id: "demo:task:7", title: "assigned", status: "assigned", assignedAgentIds: ["mate-bo"] },
      ]),
      TEAM,
    );
    expect(q.map((e) => e.taskId)).toEqual(["demo:task:7"]);
  });

  it("orders by creation time, then by id, whatever order the state lists them", () => {
    const tasks: TaskInput[] = [
      { id: task(3), title: "c", status: "queued", createdAt: "2026-11-01T10:00:03.000Z" },
      { id: task(2), title: "b2", status: "queued", createdAt: "2026-11-01T10:00:01.000Z" },
      { id: task(1), title: "b1", status: "queued", createdAt: "2026-11-01T10:00:01.000Z" },
      { id: task(4), title: "a", status: "queued", createdAt: "2026-11-01T10:00:00.000Z" },
    ];
    const expected = [task(4), task(1), task(2), task(3)];
    expect(dispatchQueue(state(tasks), TEAM).map((e) => e.taskId)).toEqual(expected);
    expect(dispatchQueue(state([...tasks].reverse()), TEAM).map((e) => e.taskId)).toEqual(expected);
  });

  it("is a pure read: the same state gives equal queues and the state is not changed", () => {
    const s = state([{ id: task(1), title: "t", status: "queued" }]);
    const before = JSON.stringify(s);
    expect(dispatchQueue(s, TEAM)).toEqual(dispatchQueue(s, TEAM));
    expect(JSON.stringify(s)).toBe(before);
  });
});

describe("teamProgress", () => {
  it("counts completed over total from the same recorded tasks as the queue", () => {
    const s = state([
      { id: task(1), title: "a", status: "completed" },
      { id: task(2), title: "b", status: "running", assignedAgentIds: ["mate-pip"] },
      { id: task(3), title: "c", status: "queued" },
      { id: task(4), title: "d", status: "completed" },
      { id: task(1, "session-0d2f9c11"), title: "other", status: "completed" },
    ]);
    expect(teamProgress(s, TEAM)).toMatchObject({ completed: 2, total: 4 });
    expect(dispatchQueue(s, TEAM)).toHaveLength(4);
  });

  it("is zero over zero for a team with no tasks, not an invented total", () => {
    expect(teamProgress(state([]), TEAM)).toMatchObject({ completed: 0, total: 0 });
  });
});
