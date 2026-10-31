import { z } from "zod";
import {
  ACTIVITIES,
  AGENT_KINDS,
  COMMAND_TYPES,
  normalizeSourceEnum,
  REQUEST_KINDS,
  REQUEST_RESOLUTIONS,
  sourceEnumValueSchema,
  sourceValueSchema,
  TASK_STATUSES,
  TEAM_MESSAGE_KINDS,
  TOOL_CALL_FINISH_PHASES,
} from "./enums.ts";
import type { EventType } from "./event-types.ts";
import {
  absolutePathSchema,
  idSchema,
  inputPreviewSchema,
  inputReasonSchema,
  nonEmptyTextSchema,
  nonNegativeIntSchema,
  shaSchema,
  storedReasonSchema,
  textSchema,
  timestampSchema,
} from "./primitives.ts";

// Payload schemas per event type (contracts/events.md "Event types in v1").
//
// Two maps share every schema except where input and stored forms differ:
// - `reason` is a string on input and `{ text, masked, truncated }` once stored (FR-017);
// - open enums (agent kind, task status, activity) accept any string on input and normalize it,
//   while the stored form accepts only the normalized value.

const empty = z.strictObject({});

const commonPayloadSchemas = {
  "project.created": z.strictObject({
    name: nonEmptyTextSchema,
    roots: z.array(absolutePathSchema),
    builtin: z.boolean(),
  }),
  "agent.connected": empty,
  "agent.disconnected": empty,
  "agent.finished": z.strictObject({
    outcome: textSchema.optional(),
    summary: textSchema.optional(),
  }),
  "team.started": z.strictObject({
    teamId: idSchema,
    leadAgentId: idSchema,
    name: textSchema.optional(),
  }),
  "team.ended": z.strictObject({ teamId: idSchema }),
  // A message between agents (Claude Code SendMessage). The envelope agentId is the sender;
  // `to` is the recipient's name as the sender wrote it, since it may not name a known agent.
  "team.message": z.strictObject({
    to: nonEmptyTextSchema,
    kind: z.enum(TEAM_MESSAGE_KINDS),
    summary: textSchema.optional(),
  }),
  "session.started": z.strictObject({ workingDirectory: textSchema.optional() }),
  "session.ended": z.strictObject({ outcome: textSchema.optional() }),
  "session.prompt_submitted": empty,
  "session.turn_ended": empty,
  "session.idle_prompt": empty,
  "task.created": z.strictObject({
    title: nonEmptyTextSchema,
    relatedTaskIds: z.array(idSchema).optional(),
  }),
  "task.assigned": z.strictObject({ agentIds: z.array(idSchema).min(1) }),
  "task.handoff": z.strictObject({
    fromAgentId: idSchema,
    toAgentId: idSchema,
    note: textSchema.optional(),
  }),
  "activity.ended": empty,
  "tool_call.started": z.strictObject({
    toolCallId: idSchema,
    toolName: nonEmptyTextSchema,
    filePaths: z.array(textSchema).optional(),
    summary: textSchema.optional(),
  }),
  "tool_call.finished": z.strictObject({
    toolCallId: idSchema,
    phase: z.enum(TOOL_CALL_FINISH_PHASES),
    durationMs: nonNegativeIntSchema.optional(),
    summary: textSchema.optional(),
  }),
  "request.resolved": z.strictObject({
    requestId: idSchema,
    resolution: z.enum(REQUEST_RESOLUTIONS),
  }),
  "request.expired": z.strictObject({ requestId: idSchema }),
  "command.requested": z.strictObject({
    commandId: idSchema,
    commandType: z.enum(COMMAND_TYPES),
    requestId: idSchema,
    payload: z.record(z.string(), z.unknown()),
    idempotencyKey: idSchema,
  }),
  "command.delivered": z.strictObject({ commandId: idSchema }),
  "command.succeeded": z.strictObject({ commandId: idSchema }),
  "command.expired": z.strictObject({ commandId: idSchema }),
  "command.unsupported": z.strictObject({ commandId: idSchema }),
  "test.result": z.strictObject({
    passed: nonNegativeIntSchema,
    failed: nonNegativeIntSchema,
    skipped: nonNegativeIntSchema,
    summary: textSchema.optional(),
  }),
  "git.commit": z.strictObject({
    repo: nonEmptyTextSchema,
    sha: shaSchema,
    parents: z.array(shaSchema),
    subject: textSchema.optional(),
  }),
  "git.ref_moved": z.strictObject({
    repo: nonEmptyTextSchema,
    ref: nonEmptyTextSchema,
    from: shaSchema.optional(),
    to: shaSchema,
  }),
  "git.merge": z.strictObject({
    repo: nonEmptyTextSchema,
    sha: shaSchema,
    parents: z.array(shaSchema).min(2),
  }),
};

const agentRegisteredShape = {
  sourceAgentId: idSchema,
  displayName: textSchema,
  role: textSchema,
  parentAgentId: idSchema.optional(),
  teamId: idSchema.optional(),
  /** True when the source guessed this identity or link instead of recording it (#120). */
  heuristic: z.boolean().optional(),
};

const requestOpenedShape = {
  requestId: idSchema,
  kind: z.enum(REQUEST_KINDS),
  toolName: textSchema.optional(),
  inputPreview: inputPreviewSchema.optional(),
  expiresAt: timestampSchema.optional(),
  /** True when the source guessed which agent the request belongs to (#120). */
  heuristic: z.boolean().optional(),
};

/** `{ [field]: value, sourceValue? }` for a normalized open enum field. */
function enumField<const F extends string, const V extends readonly string[]>(
  field: F,
  values: V,
  raw: string,
  sourceValue: string | undefined,
): { [K in F]: V[number] } & { sourceValue?: string } {
  const normalized = normalizeSourceEnum(values, raw, sourceValue);
  const out: Record<string, string> = { [field]: normalized.value };
  if (normalized.sourceValue !== undefined) out.sourceValue = normalized.sourceValue;
  return out as { [K in F]: V[number] } & { sourceValue?: string };
}

/** Stored form: `sourceValue` only alongside `unknown`. */
const sourceValueOnlyWithUnknown =
  (field: string) => (payload: Record<string, unknown>, ctx: z.RefinementCtx) => {
    if (payload.sourceValue !== undefined && payload[field] !== "unknown") {
      ctx.addIssue({
        code: "custom",
        path: ["sourceValue"],
        message: `sourceValue is only kept when ${field} is "unknown"`,
      });
    }
  };

/**
 * `parentAgentId` only with `subagent`, `teamId` only with `lead` or `teammate`. An `unknown`
 * kind carries whatever the source sent, since Taskville cannot know its rules.
 */
const agentKindRules = (
  payload: { kind: string; parentAgentId?: string | undefined; teamId?: string | undefined },
  ctx: z.RefinementCtx,
) => {
  if (payload.kind === "unknown") return;
  if (payload.parentAgentId !== undefined && payload.kind !== "subagent") {
    ctx.addIssue({
      code: "custom",
      path: ["parentAgentId"],
      message: "parentAgentId is only allowed when kind is subagent",
    });
  }
  if (payload.teamId !== undefined && payload.kind !== "lead" && payload.kind !== "teammate") {
    ctx.addIssue({
      code: "custom",
      path: ["teamId"],
      message: "teamId is only allowed when kind is lead or teammate",
    });
  }
};

export const inputPayloadSchemas = {
  ...commonPayloadSchemas,
  "agent.registered": z
    .strictObject({
      ...agentRegisteredShape,
      kind: sourceEnumValueSchema(AGENT_KINDS),
      sourceValue: sourceValueSchema.optional(),
    })
    .transform(({ kind, sourceValue, ...rest }) => ({
      ...rest,
      ...enumField("kind", AGENT_KINDS, kind, sourceValue),
    }))
    .superRefine(agentKindRules),
  "session.turn_failed": z.strictObject({ reason: inputReasonSchema.optional() }),
  "task.status_changed": z
    .strictObject({
      status: sourceEnumValueSchema(TASK_STATUSES),
      sourceValue: sourceValueSchema.optional(),
      reason: inputReasonSchema.optional(),
    })
    .transform(({ status, sourceValue, ...rest }) => ({
      ...rest,
      ...enumField("status", TASK_STATUSES, status, sourceValue),
    })),
  "activity.started": z
    .strictObject({
      activity: sourceEnumValueSchema(ACTIVITIES),
      sourceValue: sourceValueSchema.optional(),
      heuristic: z.boolean().optional(),
    })
    .transform(({ activity, sourceValue, ...rest }) => ({
      ...rest,
      ...enumField("activity", ACTIVITIES, activity, sourceValue),
    })),
  "request.opened": z.strictObject({
    ...requestOpenedShape,
    reason: inputReasonSchema.optional(),
  }),
  "command.failed": z.strictObject({ commandId: idSchema, reason: inputReasonSchema }),
} satisfies Record<EventType, z.ZodType>;

export const storedPayloadSchemas = {
  ...commonPayloadSchemas,
  "agent.registered": z
    .strictObject({
      ...agentRegisteredShape,
      kind: z.enum(AGENT_KINDS),
      sourceValue: sourceValueSchema.optional(),
    })
    .superRefine(sourceValueOnlyWithUnknown("kind"))
    .superRefine(agentKindRules),
  "session.turn_failed": z.strictObject({ reason: storedReasonSchema.optional() }),
  "task.status_changed": z
    .strictObject({
      status: z.enum(TASK_STATUSES),
      sourceValue: sourceValueSchema.optional(),
      reason: storedReasonSchema.optional(),
    })
    .superRefine(sourceValueOnlyWithUnknown("status")),
  "activity.started": z
    .strictObject({
      activity: z.enum(ACTIVITIES),
      sourceValue: sourceValueSchema.optional(),
      heuristic: z.boolean().optional(),
    })
    .superRefine(sourceValueOnlyWithUnknown("activity")),
  "request.opened": z.strictObject({
    ...requestOpenedShape,
    reason: storedReasonSchema.optional(),
  }),
  "command.failed": z.strictObject({ commandId: idSchema, reason: storedReasonSchema }),
} satisfies Record<EventType, z.ZodType>;

export type InputPayloadSchemas = typeof inputPayloadSchemas;
export type StoredPayloadSchemas = typeof storedPayloadSchemas;

/** A payload as the engine holds it after input parsing (enums normalized, reason still text). */
export type InputPayload<T extends EventType> = z.output<InputPayloadSchemas[T]>;
/** A payload as stored and streamed (reason masked and truncated). */
export type StoredPayload<T extends EventType> = z.output<StoredPayloadSchemas[T]>;
