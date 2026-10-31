import { z } from "zod";
import { storedEnvelopeSchema } from "./envelope.ts";
import { nonNegativeIntSchema, positiveIntSchema } from "./primitives.ts";

// SSE frames of `GET /v1/projects/:id/events` (contracts/http-api.md). A frame is described here
// after its `data` line has been JSON-parsed and its `id` line read as a number.

export const SSE_HEARTBEAT_INTERVAL_MS = 15_000;
/** Frames queued per subscriber before it is cut off with `resnapshot` / `slow_consumer`. */
export const SSE_SUBSCRIBER_QUEUE_LIMIT = 1000;

export const RESNAPSHOT_REASONS = [
  "cursor_ahead_of_head",
  "slow_consumer",
  "reducer_rebuilt",
] as const;
export type ResnapshotReason = (typeof RESNAPSHOT_REASONS)[number];

/** `event: event`; `id` is the envelope's ingest sequence, so clients resume from it. */
export const sseEventFrameSchema = z
  .strictObject({ event: z.literal("event"), id: positiveIntSchema, data: storedEnvelopeSchema })
  .superRefine((frame, ctx) => {
    if (frame.id !== frame.data.ingestSequence) {
      ctx.addIssue({ code: "custom", path: ["id"], message: "id must equal data.ingestSequence" });
    }
  });

/** `event: heartbeat`, every 15 s, no id. */
export const sseHeartbeatFrameSchema = z.strictObject({
  event: z.literal("heartbeat"),
  data: z.strictObject({ head: nonNegativeIntSchema }),
});

/** `event: resnapshot`; the server closes the stream after it. */
export const sseResnapshotFrameSchema = z.strictObject({
  event: z.literal("resnapshot"),
  data: z.strictObject({ reason: z.enum(RESNAPSHOT_REASONS) }),
});

export const sseFrameSchema = z.discriminatedUnion("event", [
  sseEventFrameSchema,
  sseHeartbeatFrameSchema,
  sseResnapshotFrameSchema,
]);
export type SseFrame = z.output<typeof sseFrameSchema>;
export type SseEventName = SseFrame["event"];
