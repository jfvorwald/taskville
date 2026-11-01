import { z } from "zod";
import { ID_MAX_LENGTH } from "./primitives.ts";

// Enumerations from data-model.md and ARCHITECTURE.md section 6.
//
// Open enums are supplied by sources and describe state. An unrecognized source value is kept as
// `unknown` with the original in a sibling `sourceValue` field (constitution IV). Closed enums
// drive requests, commands, and attention, so an unrecognized value is rejected instead.

export const AGENT_KINDS = ["session", "subagent", "lead", "teammate", "unknown"] as const;
export type AgentKind = (typeof AGENT_KINDS)[number];

export const TASK_STATUSES = [
  "queued",
  "assigned",
  "running",
  "blocked",
  "awaiting_input",
  "reviewing",
  "completed",
  "failed",
  "cancelled",
  "unknown",
] as const;
export type TaskStatus = (typeof TASK_STATUSES)[number];

export const ACTIVITIES = [
  "idle",
  "implementing",
  "testing",
  "reviewing",
  "researching",
  "documenting",
  "dispatching",
  "handing_off",
  "waiting",
  "unknown",
] as const;
export type Activity = (typeof ACTIVITIES)[number];

/**
 * Kinds of `team.message`. Closed: the Claude Code adapter maps any other SendMessage type to
 * `unknown` itself, so a producer never needs a new value to send one.
 */
export const TEAM_MESSAGE_KINDS = [
  "message",
  "shutdown_request",
  "shutdown_response",
  "unknown",
] as const;
export type TeamMessageKind = (typeof TEAM_MESSAGE_KINDS)[number];

export const CONNECTIONS = ["connected", "disconnected", "unknown"] as const;
export type Connection = (typeof CONNECTIONS)[number];

/** Phases a `tool_call.finished` event may report. `running` is set by `tool_call.started`. */
export const TOOL_CALL_FINISH_PHASES = ["succeeded", "failed"] as const;
export const TOOL_CALL_PHASES = ["running", ...TOOL_CALL_FINISH_PHASES] as const;
export type ToolCallPhase = (typeof TOOL_CALL_PHASES)[number];

export const REQUEST_KINDS = ["permission", "elicitation", "input"] as const;
export type RequestKind = (typeof REQUEST_KINDS)[number];

export const REQUEST_STATES = ["open", "answered_here", "answered_elsewhere", "expired"] as const;
export type RequestState = (typeof REQUEST_STATES)[number];

export const REQUEST_RESOLUTIONS = ["answered_here", "answered_elsewhere"] as const;
export type RequestResolution = (typeof REQUEST_RESOLUTIONS)[number];

/** Which way a terminal answer went (decision #116 D2 and D3). */
export const REQUEST_DECISIONS = ["allow", "deny"] as const;
export type RequestDecision = (typeof REQUEST_DECISIONS)[number];

export const COMMAND_TYPES = ["permission.decide", "session.open"] as const;
export type CommandType = (typeof COMMAND_TYPES)[number];

export const COMMAND_STATUSES = [
  "requested",
  "delivered",
  "succeeded",
  "failed",
  "expired",
  "unsupported",
] as const;
export type CommandStatus = (typeof COMMAND_STATUSES)[number];

export const ATTENTION_LEVELS = ["needs_you", "trouble", "waiting"] as const;
export type AttentionLevel = (typeof ATTENTION_LEVELS)[number];

/** Attention kinds allowed for each level. */
export const ATTENTION_KINDS_BY_LEVEL = {
  needs_you: REQUEST_KINDS,
  trouble: ["stop_failure", "tool_failures", "silent"],
  waiting: ["turn_ended", "idle_prompt"],
} as const satisfies Record<AttentionLevel, readonly string[]>;
export const ATTENTION_KINDS = [
  ...ATTENTION_KINDS_BY_LEVEL.needs_you,
  ...ATTENTION_KINDS_BY_LEVEL.trouble,
  ...ATTENTION_KINDS_BY_LEVEL.waiting,
] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const LAST_TURNS = ["ended", "failed", "idle_prompt"] as const;
export type LastTurn = (typeof LAST_TURNS)[number];

/** A raw value for an open enum field, before it is normalized. */
export const sourceEnumValueSchema = (values: readonly string[]) =>
  z
    .string()
    .min(1)
    .max(ID_MAX_LENGTH)
    .meta({
      description: `One of ${values.map((v) => `"${v}"`).join(", ")}. Any other value is stored as "unknown" with the original kept in sourceValue.`,
    });

/** The original source value of an open enum field whose value is `unknown`. */
export const sourceValueSchema = z.string().min(1).max(ID_MAX_LENGTH);

/**
 * Normalizes an open enum value. A known value passes through and any `sourceValue` sent with it
 * is dropped. An unrecognized value becomes `unknown` and is kept as `sourceValue`. An explicit
 * `unknown` keeps the `sourceValue` it was sent with, so normalizing twice changes nothing.
 */
export function normalizeSourceEnum<const V extends readonly string[]>(
  values: V,
  raw: string,
  sourceValue: string | undefined,
): { value: V[number]; sourceValue?: string } {
  if (raw === "unknown")
    return sourceValue === undefined ? { value: raw } : { value: raw, sourceValue };
  if ((values as readonly string[]).includes(raw)) return { value: raw };
  return { value: "unknown", sourceValue: raw };
}
