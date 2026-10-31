import { z } from "zod";
import { EVENT_TYPES, type EventType, requiredEnvelopeIds } from "./event-types.ts";
import {
  type InputPayloadSchemas,
  inputPayloadSchemas,
  type StoredPayloadSchemas,
  storedPayloadSchemas,
} from "./payloads.ts";
import {
  idSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  provenanceSchema,
  SCHEMA_VERSION,
  timestampSchema,
} from "./primitives.ts";

// Envelopes (contracts/events.md, ARCHITECTURE.md section 7.1). Producers send input events; the
// engine adds `eventId`, `receivedAt`, and `ingestSequence` and returns stored envelopes.

const inputEnvelopeShape = {
  schemaVersion: z.literal(SCHEMA_VERSION),
  projectId: idSchema,
  sourceId: idSchema,
  sourceEventId: idSchema,
  sourceSequence: nonNegativeIntSchema.optional(),
  occurredAt: timestampSchema,
  agentId: idSchema.optional(),
  sessionId: idSchema.optional(),
  taskId: idSchema.optional(),
  correlationId: idSchema.optional(),
  evidenceIds: z.array(idSchema).default([]),
  provenance: provenanceSchema,
  late: z.boolean().default(false),
};

const storedEnvelopeShape = {
  ...inputEnvelopeShape,
  evidenceIds: z.array(idSchema),
  late: z.boolean(),
  eventId: z.uuid(),
  receivedAt: timestampSchema,
  ingestSequence: positiveIntSchema,
};

type EventMember<S extends z.ZodRawShape, T extends EventType, P extends z.ZodType> = z.ZodObject<
  S & { type: z.ZodLiteral<T>; payload: P },
  z.core.$strict
>;
type EventMembers<S extends z.ZodRawShape, M extends Record<EventType, z.ZodType>> = {
  [T in EventType]: EventMember<S, T, M[T]>;
};

const requireEnvelopeIds =
  (type: EventType) => (event: Record<string, unknown>, ctx: z.RefinementCtx) => {
    for (const field of requiredEnvelopeIds(type)) {
      if (event[field] === undefined) {
        ctx.addIssue({ code: "custom", path: [field], message: `${type} requires ${field}` });
      }
    }
  };

function buildMembers<S extends z.ZodRawShape, M extends Record<EventType, z.ZodType>>(
  shape: S,
  payloads: M,
): EventMembers<S, M> {
  const members: Record<string, z.ZodType> = {};
  for (const type of EVENT_TYPES) {
    members[type] = z
      .strictObject({ ...shape, type: z.literal(type), payload: payloads[type] })
      .superRefine(requireEnvelopeIds(type));
  }
  return members as EventMembers<S, M>;
}

type Union<M extends Record<EventType, z.ZodType>> = [M[EventType], ...M[EventType][]];

/** Input event schema for each type, keyed by type. */
export const inputEventSchemas = buildMembers(inputEnvelopeShape, inputPayloadSchemas);
/** Stored envelope schema for each type, keyed by type. */
export const storedEnvelopeSchemas = buildMembers(storedEnvelopeShape, storedPayloadSchemas);

type InputMembers = EventMembers<typeof inputEnvelopeShape, InputPayloadSchemas>;
type StoredMembers = EventMembers<typeof storedEnvelopeShape, StoredPayloadSchemas>;

/** Any input event, discriminated on `type`. Prefer `parseInputEvent` for ingest error codes. */
export const inputEventSchema = z.discriminatedUnion(
  "type",
  EVENT_TYPES.map((type) => inputEventSchemas[type]) as Union<InputMembers>,
);

/** Any stored envelope, discriminated on `type`. */
export const storedEnvelopeSchema = z.discriminatedUnion(
  "type",
  EVENT_TYPES.map((type) => storedEnvelopeSchemas[type]) as Union<StoredMembers>,
);

/** An input event after parsing: defaults applied, open enums normalized. */
export type InputEvent = z.output<typeof inputEventSchema>;
/** An input event as producers write it (before defaults and enum normalization). */
export type InputEventWire = z.input<typeof inputEventSchema>;
export type InputEventOf<T extends EventType> = Extract<InputEvent, { type: T }>;

/** A stored envelope as the engine returns and streams it. */
export type StoredEnvelope = z.output<typeof storedEnvelopeSchema>;
export type StoredEnvelopeOf<T extends EventType> = Extract<StoredEnvelope, { type: T }>;
