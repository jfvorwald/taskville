import { storedEnvelopeSchemas } from "../../../../../../packages/protocol/src/index.ts";
import { initialState, reduce, type StoredEnvelope } from "../../../../src/data/domain.ts";

export const PROJECT = "team-integration";
export const TEAM = "claude-code:team:integration";
export const TASK = "claude-code:task:integration:1";
export const OTHER_TASK = "claude-code:task:other:1";
export const AT = "2026-11-01T12:00:00.000Z";

// Real envelopes and reducer state, shared by the movement and mounted-city checks.
export function teamScenario() {
  let seq = 0;
  const event = (
    type: StoredEnvelope["type"],
    payload: Record<string, unknown>,
    taskId?: string,
  ) => {
    seq++;
    return storedEnvelopeSchemas[type].parse({
      schemaVersion: 1,
      projectId: PROJECT,
      sourceId: "claude-code",
      sourceEventId: `team-${seq}`,
      eventId: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
      type,
      payload,
      occurredAt: AT,
      receivedAt: AT,
      ingestSequence: seq,
      evidenceIds: [],
      provenance: "live",
      late: false,
      agentId: "pip",
      ...(taskId === undefined ? {} : { taskId }),
    }) as StoredEnvelope;
  };
  const registration = (id: string, kind: "lead" | "teammate") => ({
    ...event("agent.registered", {
      sourceAgentId: id,
      displayName: id,
      role: "dev",
      kind,
      teamId: TEAM,
    }),
    agentId: id,
  });
  const events = [
    registration("lead", "lead"),
    registration("pip", "teammate"),
    registration("bo", "teammate"),
    event("team.started", { teamId: TEAM, leadAgentId: "lead" }),
    event("task.created", { title: "Test the parser" }, TASK),
    event("task.created", { title: "Other team's task" }, OTHER_TASK),
    event("activity.started", { activity: "idle" }),
  ];
  const state = events.reduce(reduce, initialState(PROJECT));
  return {
    state,
    claim: () => event("task.assigned", { agentIds: ["pip"] }, TASK),
    work: (activity: "implementing" | "testing" = "testing") =>
      event("activity.started", { activity }),
    leadWork: (at = AT) => ({
      ...event("activity.started", { activity: "researching" }),
      agentId: "lead",
      occurredAt: at,
      receivedAt: at,
    }),
    endTeam: () => event("team.ended", { teamId: TEAM }),
    createTask: (taskId: string) => event("task.created", { title: `Task ${taskId}` }, taskId),
    complete: () => event("task.status_changed", { status: "completed" }, TASK),
  };
}
