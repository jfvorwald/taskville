import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { parseInputEvent } from "../../../../protocol/src/index.ts";
import { type CrewContext, mapCrewHook } from "../../../src/claude-code/crew/index.ts";

// M2.20: the lead's TaskCreated (no team_name, the team does not exist yet) and the teammate's
// TaskCompleted (team_name `session-<first 8 of the lead's session_id>`) are one team task.
// team-task.fixture.jsonl holds those two hooks from the M2.10 live team run (redacted, IDs real).
// The relation team_name = `session-` + lead session_id[0..8] holds in every recorded team:
// fixtures/claude-code/team/* (a7286c33, cf46f41b, a127629f) and the M2.10 run (b4395a96).

const ctx: CrewContext = {
  projectId: "proj-1",
  sourceEventId: "evt-1",
  receivedAt: "2026-10-31T12:00:00.000Z",
  late: false,
};
const hooks = readFileSync(new URL("./team-task.fixture.jsonl", import.meta.url), "utf8")
  .split("\n")
  .filter((l) => l !== "")
  .map((l) => (JSON.parse(l) as { input: Record<string, unknown> }).input);
const hook = (name: string) => {
  const found = hooks.find((h) => h.hook_event_name === name);
  if (found === undefined) throw new Error(`fixture has no ${name}`);
  return found;
};
const one = (payload: unknown) => {
  const { events } = mapCrewHook(payload, ctx);
  expect(events).toHaveLength(1);
  const [e] = events;
  expect(parseInputEvent(e).ok, JSON.stringify(e)).toBe(true);
  return e;
};

describe("a team task across the lead and a teammate (recorded hooks)", () => {
  it("fixture shape: the lead has no team_name; the teammate's matches the lead's session", () => {
    const created = hook("TaskCreated");
    const completed = hook("TaskCompleted");
    expect(created.team_name).toBeUndefined();
    expect(completed.team_name).toBe(`session-${String(created.session_id).slice(0, 8)}`);
  });

  it("maps the lead's TaskCreated and the teammate's TaskCompleted to one task ID", () => {
    const created = one(hook("TaskCreated"));
    const completed = one(hook("TaskCompleted"));
    expect(created?.type).toBe("task.created");
    expect(completed?.type).toBe("task.status_changed");
    expect(created?.taskId).toBeDefined();
    expect(completed?.taskId).toBe(created?.taskId);
  });

  it("keeps different sessions' tasks apart", () => {
    const created = hook("TaskCreated");
    const other = { ...created, session_id: "0d2f9c11-aaaa-4bbb-8ccc-123456789abc" };
    expect(one(other)?.taskId).not.toBe(one(created)?.taskId);
  });

  it("keeps different task IDs of one team apart", () => {
    const created = hook("TaskCreated");
    expect(one({ ...created, task_id: "2" })?.taskId).not.toBe(one(created)?.taskId);
  });
});
