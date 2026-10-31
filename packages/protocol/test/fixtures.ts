import type { EventType } from "../src/index.ts";

export const SHA_A = "a".repeat(40);
export const SHA_B = "b".repeat(40);
export const SHA_C = "c".repeat(40);

/** One valid input payload per event type. Typed by EventType so a new type fails typecheck here. */
export const validPayloads: Record<EventType, Record<string, unknown>> = {
  "project.created": { name: "Taskville", roots: ["/repo/taskville"], builtin: false },
  "agent.registered": {
    sourceAgentId: "sa-1",
    displayName: "Builder",
    role: "implementer",
    kind: "subagent",
    parentAgentId: "agent-0",
    heuristic: false,
  },
  "agent.connected": {},
  "agent.disconnected": {},
  "agent.finished": { outcome: "completed", summary: "done" },
  "team.started": { teamId: "team-1", leadAgentId: "agent-0", name: "Wave 1" },
  "team.ended": { teamId: "team-1" },
  "team.message": { to: "bo", kind: "message", summary: "Greeting bo" },
  "session.started": { workingDirectory: "/repo/taskville" },
  "session.ended": { outcome: "exited" },
  "session.prompt_submitted": {},
  "session.turn_ended": {},
  "session.turn_failed": { reason: "API error" },
  "session.idle_prompt": {},
  "task.created": { title: "Write protocol", relatedTaskIds: ["task-0"] },
  "task.assigned": { agentIds: ["agent-1"] },
  "task.status_changed": { status: "running", reason: "started" },
  "task.handoff": { fromAgentId: "agent-1", toAgentId: "agent-2", note: "over to you" },
  "activity.started": { activity: "testing", heuristic: true },
  "activity.ended": {},
  "tool_call.started": {
    toolCallId: "tc-1",
    toolName: "Bash",
    filePaths: ["src/index.ts"],
    summary: "pnpm test",
  },
  "tool_call.finished": {
    toolCallId: "tc-1",
    phase: "failed",
    durationMs: 1200,
    summary: "exit 1",
  },
  "request.opened": {
    requestId: "req-1",
    kind: "permission",
    toolName: "Bash",
    inputPreview: "rm -rf build",
    reason: "Bash wants to run a command",
    expiresAt: "2026-10-30T12:05:00Z",
    heuristic: true,
  },
  "request.resolved": { requestId: "req-1", resolution: "answered_here" },
  "request.expired": { requestId: "req-1" },
  "command.requested": {
    commandId: "cmd-1",
    commandType: "permission.decide",
    requestId: "req-1",
    payload: { decision: "allow" },
    idempotencyKey: "idem-1",
  },
  "command.delivered": { commandId: "cmd-1" },
  "command.succeeded": { commandId: "cmd-1" },
  "command.expired": { commandId: "cmd-1" },
  "command.unsupported": { commandId: "cmd-1" },
  "command.failed": { commandId: "cmd-1", reason: "request no longer open" },
  "test.result": { passed: 10, failed: 1, skipped: 0, summary: "1 failing" },
  "git.commit": { repo: "taskville", sha: SHA_A, parents: [SHA_B], subject: "Add protocol" },
  "git.ref_moved": { repo: "taskville", ref: "refs/heads/main", from: SHA_A, to: SHA_B },
  "git.merge": { repo: "taskville", sha: SHA_C, parents: [SHA_A, SHA_B] },
};

/** One invalid input payload per event type, with the path the rejection must name. */
export const invalidPayloads: Record<
  EventType,
  { payload: Record<string, unknown>; path: string }
> = {
  "project.created": {
    payload: { name: "x", roots: [], builtin: "no" },
    path: "payload.builtin",
  },
  "agent.registered": {
    payload: {
      sourceAgentId: "sa-1",
      displayName: "Lead",
      role: "lead",
      kind: "session",
      parentAgentId: "agent-0",
    },
    path: "payload.parentAgentId",
  },
  "agent.connected": { payload: { extra: 1 }, path: "payload.extra" },
  "agent.disconnected": { payload: { extra: 1 }, path: "payload.extra" },
  "agent.finished": { payload: { outcome: 5 }, path: "payload.outcome" },
  "team.started": { payload: { leadAgentId: "agent-0" }, path: "payload.teamId" },
  "team.ended": { payload: {}, path: "payload.teamId" },
  "team.message": { payload: { to: "bo", kind: "telepathy" }, path: "payload.kind" },
  "session.started": { payload: { workingDirectory: 3 }, path: "payload.workingDirectory" },
  "session.ended": { payload: { outcome: false }, path: "payload.outcome" },
  "session.prompt_submitted": { payload: { extra: 1 }, path: "payload.extra" },
  "session.turn_ended": { payload: { extra: 1 }, path: "payload.extra" },
  "session.turn_failed": { payload: { reason: "x".repeat(4001) }, path: "payload.reason" },
  "session.idle_prompt": { payload: { extra: 1 }, path: "payload.extra" },
  "task.created": { payload: { title: "" }, path: "payload.title" },
  "task.assigned": { payload: { agentIds: [] }, path: "payload.agentIds" },
  "task.status_changed": { payload: {}, path: "payload.status" },
  "task.handoff": { payload: { fromAgentId: "agent-1" }, path: "payload.toAgentId" },
  "activity.started": { payload: { activity: 7 }, path: "payload.activity" },
  "activity.ended": { payload: { extra: 1 }, path: "payload.extra" },
  "tool_call.started": { payload: { toolCallId: "tc-1" }, path: "payload.toolName" },
  "tool_call.finished": {
    payload: { toolCallId: "tc-1", phase: "running" },
    path: "payload.phase",
  },
  "request.opened": { payload: { requestId: "req-1", kind: "approval" }, path: "payload.kind" },
  "request.resolved": {
    payload: { requestId: "req-1", resolution: "answered" },
    path: "payload.resolution",
  },
  "request.expired": { payload: {}, path: "payload.requestId" },
  "command.requested": {
    payload: {
      commandId: "cmd-1",
      commandType: "shell.run",
      requestId: "req-1",
      payload: {},
      idempotencyKey: "idem-1",
    },
    path: "payload.commandType",
  },
  "command.delivered": { payload: {}, path: "payload.commandId" },
  "command.succeeded": { payload: {}, path: "payload.commandId" },
  "command.expired": { payload: {}, path: "payload.commandId" },
  "command.unsupported": { payload: {}, path: "payload.commandId" },
  "command.failed": { payload: { commandId: "cmd-1" }, path: "payload.reason" },
  "test.result": { payload: { passed: -1, failed: 0, skipped: 0 }, path: "payload.passed" },
  "git.commit": { payload: { repo: "taskville", sha: "zz", parents: [] }, path: "payload.sha" },
  "git.ref_moved": {
    payload: { repo: "taskville", ref: "refs/heads/main" },
    path: "payload.to",
  },
  "git.merge": {
    payload: { repo: "taskville", sha: SHA_C, parents: [SHA_A] },
    path: "payload.parents",
  },
};

/** A wire-format input event with every optional envelope ID filled in. */
export function wireEvent(
  type: string,
  payload: Record<string, unknown>,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    schemaVersion: 1,
    projectId: "proj-a",
    sourceId: "adapter:generic",
    sourceEventId: `e-${type}`,
    occurredAt: "2026-10-30T12:00:00.000Z",
    type,
    agentId: "agent-1",
    sessionId: "session-1",
    taskId: "task-1",
    payload,
    provenance: "live",
    ...overrides,
  };
}

/**
 * Turns a parsed input event into the stored envelope the engine would write, standing in for
 * the redaction module (M1.20): every input `reason` string becomes the stored reason object.
 */
export function storedFrom(
  event: Record<string, unknown>,
  ingestSequence = 1,
): Record<string, unknown> {
  const payload = { ...(event.payload as Record<string, unknown>) };
  if (typeof payload.reason === "string") {
    payload.reason = { text: payload.reason, masked: false, truncated: false };
  }
  return {
    ...event,
    payload,
    eventId: "0b6c2d8e-6a0f-4f7e-9c1d-2f4b8a6e3c10",
    receivedAt: "2026-10-30T12:00:01.000Z",
    ingestSequence,
  };
}
