// Event types in protocol v1 (contracts/events.md, ARCHITECTURE.md section 7.1).

export const EVENT_TYPES = [
  "project.created",
  "agent.registered",
  "agent.connected",
  "agent.disconnected",
  "agent.finished",
  "team.started",
  "team.ended",
  "team.message",
  "session.started",
  "session.ended",
  "session.prompt_submitted",
  "session.turn_ended",
  "session.turn_failed",
  "session.idle_prompt",
  "task.created",
  "task.assigned",
  "task.status_changed",
  "task.handoff",
  "activity.started",
  "activity.ended",
  "tool_call.started",
  "tool_call.finished",
  "request.opened",
  "request.resolved",
  "request.expired",
  "command.requested",
  "command.delivered",
  "command.succeeded",
  "command.expired",
  "command.unsupported",
  "command.failed",
  "test.result",
  "git.commit",
  "git.ref_moved",
  "git.merge",
] as const;
export type EventType = (typeof EVENT_TYPES)[number];

/**
 * Types only the engine emits, under a `taskville:` source. `POST /v1/events/batch` rejects them
 * with `engine_only_type`.
 */
export const ENGINE_ONLY_EVENT_TYPES = [
  "project.created",
  "request.resolved",
  "request.expired",
  "command.requested",
  "command.delivered",
  "command.succeeded",
  "command.expired",
  "command.unsupported",
  "command.failed",
] as const satisfies readonly EventType[];
export type EngineOnlyEventType = (typeof ENGINE_ONLY_EVENT_TYPES)[number];

/** Source ID prefix reserved for the engine (`taskville:bridge`, ...). */
export const RESERVED_SOURCE_PREFIX = "taskville:";

const eventTypes: ReadonlySet<string> = new Set(EVENT_TYPES);
const engineOnly: ReadonlySet<string> = new Set(ENGINE_ONLY_EVENT_TYPES);

export const isEventType = (value: string): value is EventType => eventTypes.has(value);
export const isEngineOnlyEventType = (value: string): value is EngineOnlyEventType =>
  engineOnly.has(value);

export type EnvelopeIdField = "agentId" | "sessionId" | "taskId";

/**
 * Envelope IDs each type needs to have an effect: the entity the event is about. Missing ones are
 * rejected as `invalid_envelope` so the reducer never has to guess the subject.
 */
export function requiredEnvelopeIds(type: EventType): readonly EnvelopeIdField[] {
  const family = type.slice(0, type.indexOf("."));
  switch (family) {
    case "agent":
    case "activity":
    case "tool_call":
      return ["agentId"];
    case "session":
      return ["agentId", "sessionId"];
    case "task":
      return ["taskId"];
    default:
      // team.message is about its sender.
      return type === "request.opened" || type === "team.message" ? ["agentId"] : [];
  }
}
