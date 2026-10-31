import { describe, expect, it } from "vitest";
import { parseInputEvent } from "../../../../protocol/src/index.ts";
import { type CrewContext, mapCrewHook } from "../../../src/claude-code/crew/index.ts";
import { redactText } from "../../../src/redact/index.ts";

// Edge cases the recorded streams do not cover: unrecorded team task hooks, failed or odd
// SendMessage calls, unparseable worker prompts, secrets in agent text, hostile JSON.

const SESSION = "1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const LEAD = `claude-code:${SESSION}`;
const ctx: CrewContext = {
  projectId: "proj-1",
  sourceEventId: "evt-1",
  receivedAt: "2026-10-30T12:00:00.000Z",
  late: false,
};
const map = (payload: unknown, c: Partial<CrewContext> = {}) =>
  mapCrewHook(payload, { ...ctx, ...c });
const valid = (payload: unknown) => {
  const { events } = map(payload);
  for (const e of events) expect(parseInputEvent(e).ok, JSON.stringify(e)).toBe(true);
  return events;
};

const SECRET = `ghp_${"A1b2C3d4E5".repeat(4)}`;

describe("team task hooks (documented fields; not recorded in S-2)", () => {
  const base = { session_id: SESSION, task_id: "7", team_name: "session-1469cdbe" };

  it("maps TaskCreated to task.created scoped by team", () => {
    const events = valid({ ...base, hook_event_name: "TaskCreated", task_subject: "Write docs" });
    expect(events).toMatchObject([
      {
        type: "task.created",
        agentId: LEAD,
        taskId: "claude-code:task:session-1469cdbe:7",
        payload: { title: "Write docs" },
      },
    ]);
  });

  it("maps TaskCompleted to task.status_changed completed", () => {
    expect(valid({ ...base, hook_event_name: "TaskCompleted" })).toMatchObject([
      { type: "task.status_changed", payload: { status: "completed" } },
    ]);
  });

  it("masks a secret in a task title", () => {
    const [e] = valid({ ...base, hook_event_name: "TaskCreated", task_subject: `use ${SECRET}` });
    expect(JSON.stringify(e)).not.toContain(SECRET);
  });

  it("ignores a task hook without a usable task_id", () => {
    expect(map({ ...base, hook_event_name: "TaskCreated", task_id: "../x" }).events).toEqual([]);
  });
});

describe("SendMessage", () => {
  const post = (tool_input: unknown, tool_response: unknown, extra: object = {}) => ({
    session_id: SESSION,
    hook_event_name: "PostToolUse",
    tool_name: "SendMessage",
    tool_input,
    tool_response,
    ...extra,
  });

  it("emits nothing when the send did not succeed", () => {
    expect(map(post({ to: "bo", message: "hi" }, { success: false })).events).toEqual([]);
  });

  it("keeps the message body out of the event and masks the summary", () => {
    const events = valid(
      post({ to: "bo", message: `body ${SECRET}`, summary: `token ${SECRET}` }, { success: true }),
    );
    const text = JSON.stringify(events);
    expect(text).not.toContain(SECRET);
    expect(text).not.toContain("body");
  });

  it("maps an unknown structured message type to kind unknown", () => {
    expect(
      valid(post({ to: "bo", message: { type: "plan_approval_request" } }, { success: true })),
    ).toMatchObject([{ type: "team.message", payload: { kind: "unknown" } }]);
  });

  it("does not take team-lead as a teammate name", () => {
    const events = valid(
      post({ to: "bo", message: "x" }, { success: true, routing: { sender: "team-lead" } }),
    );
    expect(events.map((e) => e.type)).toEqual(["team.message"]);
  });

  it("does not name an in-process sender from routing, since agent_id already identifies it", () => {
    const events = valid(
      post(
        { to: "bo", message: "x" },
        { success: true, routing: { sender: "pip" } },
        { agent_id: "apip-5cb5e9bb3f2f1097", agent_type: "pip" },
      ),
    );
    expect(events.map((e) => e.type)).toEqual(["team.message"]);
  });

  it("ignores prototype keys in the response", () => {
    const hostile = JSON.parse(
      '{"__proto__": {"success": true, "routing": {"sender": "pip"}}}',
    ) as unknown;
    expect(map(post({ to: "bo", message: "x" }, hostile)).events).toEqual([]);
  });
});

describe("worker permission prompt", () => {
  const note = (message: unknown) => ({
    session_id: SESSION,
    hook_event_name: "Notification",
    notification_type: "worker_permission_prompt",
    message,
  });

  it("still marks the lead, heuristically, when the English text does not parse", () => {
    expect(valid(note("Something changed"))).toMatchObject([
      {
        type: "request.opened",
        agentId: LEAD,
        payload: { reason: "for: a teammate", heuristic: true },
      },
    ]);
    const [e] = valid(note("Something changed"));
    expect(e?.payload).not.toHaveProperty("toolName");
  });

  it("gives each notification its own request, stable across a retry", () => {
    const a = map(note("pip needs permission for Bash"), { sourceEventId: "evt-a" }).events[0];
    const b = map(note("pip needs permission for Bash"), { sourceEventId: "evt-b" }).events[0];
    expect(a?.payload.requestId).not.toBe(b?.payload.requestId);
    expect(
      map(note("pip needs permission for Bash"), { sourceEventId: "evt-a" }).events[0],
    ).toEqual(a);
  });

  it("leaves a secret in the reason to the engine, which masks it and records masked: true", () => {
    // Same convention as the core mapper's reasons (core/text.ts cleanReason, FR-017): masking
    // here would make the engine store `masked: false` for masked text.
    const [e] = valid(note(`${SECRET} needs permission for Bash`));
    const reason = String(e?.payload.reason);
    expect(reason).toBe(`for: ${SECRET} (Bash)`);
    expect(redactText(reason).spans).toHaveLength(1);
  });
});

describe("context", () => {
  const start = {
    session_id: SESSION,
    hook_event_name: "SubagentStart",
    agent_id: "afdf84bea07a9064c",
    agent_type: "general-purpose",
  };

  it("carries late through to every event", () => {
    expect(map(start, { late: true }).events.every((e) => e.late)).toBe(true);
  });

  it("is deterministic", () => {
    expect(map(start)).toEqual(map(start));
  });

  it("refuses a sourceEventId that leaves no room for the per-event suffix", () => {
    expect(map(start, { sourceEventId: "x".repeat(181) }).events).toEqual([]);
  });

  it("bounds and masks a long agent_type used as a display name", () => {
    const [e] = valid({ ...start, agent_type: `${"n".repeat(500)} ${SECRET}` });
    expect(String(e?.payload.displayName).length).toBeLessThanOrEqual(64);
    expect(JSON.stringify(e)).not.toContain(SECRET);
  });

  it("does not split a surrogate pair when cutting a display name", () => {
    const [e] = valid({ ...start, agent_type: `${"n".repeat(63)}\u{1F600}x` });
    expect(String(e?.payload.displayName).isWellFormed()).toBe(true);
  });
});

describe("composed IDs stay within the 200-character protocol limit", () => {
  const longest = (n: number) => "a".repeat(n);

  it("bounds a worker requestId built from the longest accepted sourceEventId", () => {
    const note = {
      session_id: SESSION,
      hook_event_name: "Notification",
      notification_type: "worker_permission_prompt",
      message: "pip needs permission for Bash",
    };
    for (const n of [150, 170, 171, 180]) {
      for (const e of map(note, { sourceEventId: longest(n) }).events) {
        expect(parseInputEvent(e).ok, `${n}`).toBe(true);
      }
    }
  });

  it("ignores a team task whose composed taskId would be too long", () => {
    const hook = {
      session_id: SESSION,
      hook_event_name: "TaskCreated",
      task_id: longest(64),
      team_name: longest(128),
      task_subject: "x",
    };
    const result = map(hook);
    for (const e of result.events) expect(parseInputEvent(e).ok).toBe(true);
  });

  it("ignores a team spawn whose composed teamId would be too long", () => {
    const hook = {
      session_id: SESSION,
      hook_event_name: "PostToolUse",
      tool_name: "Agent",
      tool_response: { status: "teammate_spawned", team_name: longest(199), is_splitpane: true },
    };
    for (const e of map(hook).events) expect(parseInputEvent(e).ok).toBe(true);
  });
});
