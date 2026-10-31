import { z } from "zod";
import { type InputEvent, inputEventSchemas } from "./envelope.ts";
import { isEngineOnlyEventType, isEventType, RESERVED_SOURCE_PREFIX } from "./event-types.ts";
import { idSchema, positiveIntSchema, SCHEMA_VERSION } from "./primitives.ts";

/** Per-event rejection codes (contracts/events.md). */
export const REJECTION_CODES = [
  "unsupported_schema_version",
  "unknown_type",
  "invalid_envelope",
  "invalid_payload",
  "unknown_project",
  "provenance_mismatch",
  "engine_only_type",
  "reserved_source",
] as const;
export type RejectionCode = (typeof REJECTION_CODES)[number];

export const ingestErrorSchema = z.strictObject({
  code: z.enum(REJECTION_CODES),
  /** Dotted path of the offending field, e.g. `payload.status`. */
  path: z.string().optional(),
  message: z.string(),
});
export type IngestError = z.output<typeof ingestErrorSchema>;

const acceptedResultSchema = z.strictObject({
  sourceEventId: idSchema,
  status: z.literal("accepted"),
  ingestSequence: positiveIntSchema,
  eventId: z.uuid(),
});
const duplicateResultSchema = z.strictObject({
  sourceEventId: idSchema,
  status: z.literal("duplicate"),
  ingestSequence: positiveIntSchema,
  eventId: z.uuid(),
});
const conflictResultSchema = z.strictObject({
  sourceEventId: idSchema,
  status: z.literal("conflict"),
  existingEventId: z.uuid(),
});
/** `sourceEventId` is absent when the event did not carry a valid one. */
const rejectedResultSchema = z.strictObject({
  sourceEventId: idSchema.optional(),
  status: z.literal("rejected"),
  error: ingestErrorSchema,
});

/** Outcome for one event of a batch, in the batch's order. */
export const ingestResultSchema = z.discriminatedUnion("status", [
  acceptedResultSchema,
  duplicateResultSchema,
  conflictResultSchema,
  rejectedResultSchema,
]);
export type IngestResult = z.output<typeof ingestResultSchema>;
export type IngestStatus = IngestResult["status"];

export type ParseInputEventResult =
  | { ok: true; event: InputEvent }
  | { ok: false; error: IngestError };

const reject = (code: RejectionCode, path: string, message: string): ParseInputEventResult =>
  path === ""
    ? { ok: false, error: { code, message } }
    : { ok: false, error: { code, path, message } };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * Validates one input event and maps the first problem to a rejection code: `invalid_envelope`,
 * `unsupported_schema_version`, `unknown_type`, or `invalid_payload`. Codes that need engine state
 * or the sender (`unknown_project`, `engine_only_type`, `reserved_source`, `provenance_mismatch`)
 * are not checked here; see `producerPolicyViolation`.
 */
export function parseInputEvent(raw: unknown): ParseInputEventResult {
  if (!isRecord(raw)) return reject("invalid_envelope", "", "Event must be a JSON object");
  if (raw.schemaVersion === undefined) {
    return reject("invalid_envelope", "schemaVersion", "schemaVersion is required");
  }
  if (raw.schemaVersion !== SCHEMA_VERSION) {
    return reject(
      "unsupported_schema_version",
      "schemaVersion",
      `Only schemaVersion ${SCHEMA_VERSION} is supported`,
    );
  }
  const { type } = raw;
  if (typeof type !== "string") return reject("invalid_envelope", "type", "type must be a string");
  if (!isEventType(type)) return reject("unknown_type", "type", "Unknown event type");

  const result = inputEventSchemas[type].safeParse(raw);
  if (result.success) return { ok: true, event: result.data as InputEvent };

  const issue = result.error.issues[0];
  if (issue === undefined) return reject("invalid_envelope", "", "Invalid event");
  const segments: PropertyKey[] = [...issue.path];
  if (issue.code === "unrecognized_keys" && issue.keys[0] !== undefined)
    segments.push(issue.keys[0]);
  const inPayload = segments[0] === "payload" && raw.payload !== undefined;
  return reject(
    inPayload ? "invalid_payload" : "invalid_envelope",
    segments.map(String).join("."),
    issue.message,
  );
}

/**
 * Checks the rules for events sent through `POST /v1/events/batch` (and any other producer
 * route): no engine-only types, no reserved `taskville:` source, and `demo` provenance exactly
 * when the source is `demo:*`. Returns the first violation, or undefined.
 */
export function producerPolicyViolation(event: InputEvent): IngestError | undefined {
  if (isEngineOnlyEventType(event.type)) {
    return { code: "engine_only_type", path: "type", message: "Only the engine emits this type" };
  }
  if (event.sourceId.startsWith(RESERVED_SOURCE_PREFIX)) {
    return {
      code: "reserved_source",
      path: "sourceId",
      message: `Source IDs starting with "${RESERVED_SOURCE_PREFIX}" are reserved for the engine`,
    };
  }
  if (event.sourceId.startsWith("demo:") !== (event.provenance === "demo")) {
    return {
      code: "provenance_mismatch",
      path: "provenance",
      message: 'provenance must be "demo" exactly when sourceId starts with "demo:"',
    };
  }
  return undefined;
}

/** Builds the rejected result for a raw event, echoing its `sourceEventId` only if it is valid. */
export function rejectedResult(raw: unknown, error: IngestError): IngestResult {
  const sourceEventId = isRecord(raw) ? idSchema.safeParse(raw.sourceEventId) : undefined;
  return sourceEventId?.success
    ? { sourceEventId: sourceEventId.data, status: "rejected", error }
    : { status: "rejected", error };
}
