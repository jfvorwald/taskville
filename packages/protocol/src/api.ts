import { z } from "zod";
import { ATTENTION_KINDS, ATTENTION_KINDS_BY_LEVEL, ATTENTION_LEVELS } from "./enums.ts";
import { ingestResultSchema } from "./ingest.ts";
import {
  absolutePathSchema,
  idSchema,
  nonEmptyTextSchema,
  nonNegativeIntSchema,
  positiveIntSchema,
  storedReasonSchema,
  timestampSchema,
} from "./primitives.ts";

// HTTP request and response bodies (contracts/http-api.md, ARCHITECTURE.md section 10).

/** Batch limits; exceeding either is `413`, not a schema error. */
export const MAX_BATCH_EVENTS = 5000;
export const MAX_BATCH_BYTES = 5 * 1024 * 1024;

/**
 * Error codes in `{ "error": { "code", "message" } }`. The first eight are named in
 * http-api.md; `bad_request` (400), `payload_too_large` (413), `not_found` (404), and
 * `internal` (500) cover the statuses it names without a code, as apps/engine uses them.
 */
export const API_ERROR_CODES = [
  "forbidden_host",
  "forbidden_origin",
  "unauthorized",
  "credential_not_allowed",
  "invalid_pairing_code",
  "project_exists",
  "unknown_project",
  "not_implemented",
  "bad_request",
  "payload_too_large",
  "not_found",
  "internal",
  /** 503: the engine already serves its maximum number of SSE streams (security review F5). */
  "too_many_streams",
] as const;
export type ApiErrorCode = (typeof API_ERROR_CODES)[number];

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({ code: z.enum(API_ERROR_CODES), message: z.string() }),
});
export type ApiError = z.output<typeof apiErrorSchema>;

/** `POST /v1/events/batch` body. Each event is validated on its own into a per-event result. */
export const eventBatchRequestSchema = z.strictObject({ events: z.array(z.unknown()) });
export type EventBatchRequest = z.output<typeof eventBatchRequestSchema>;

/** Head (last ingest sequence) per project touched by the batch. */
export const headsSchema = z.record(idSchema, nonNegativeIntSchema);

export const eventBatchResponseSchema = z.strictObject({
  results: z.array(ingestResultSchema),
  heads: headsSchema,
});
export type EventBatchResponse = z.output<typeof eventBatchResponseSchema>;

/** `POST /v1/projects`. `id` defaults to a slug of `name`; roots are absolute directories. */
export const createProjectRequestSchema = z.strictObject({
  id: idSchema.optional(),
  name: nonEmptyTextSchema,
  roots: z.array(absolutePathSchema),
});
export type CreateProjectRequest = z.output<typeof createProjectRequestSchema>;

export const createProjectResponseSchema = z.strictObject({
  id: idSchema,
  name: nonEmptyTextSchema,
  roots: z.array(absolutePathSchema),
  head: positiveIntSchema,
});
export type CreateProjectResponse = z.output<typeof createProjectResponseSchema>;

export const projectSummarySchema = z.strictObject({
  id: idSchema,
  name: nonEmptyTextSchema,
  roots: z.array(absolutePathSchema),
  builtin: z.boolean(),
  head: nonNegativeIntSchema,
});
export type ProjectSummary = z.output<typeof projectSummarySchema>;

export const projectsResponseSchema = z.strictObject({ projects: z.array(projectSummarySchema) });
export type ProjectsResponse = z.output<typeof projectsResponseSchema>;

/** One attention record from the `attention(state, now)` selector (data-model.md). */
export const attentionSchema = z
  .strictObject({
    agentId: idSchema,
    level: z.enum(ATTENTION_LEVELS),
    kind: z.enum(ATTENTION_KINDS),
    reason: storedReasonSchema.optional(),
    since: timestampSchema,
    requestId: idSchema.optional(),
    heuristic: z.boolean(),
  })
  .superRefine((record, ctx) => {
    const allowed: readonly string[] = ATTENTION_KINDS_BY_LEVEL[record.level];
    if (!allowed.includes(record.kind)) {
      ctx.addIssue({
        code: "custom",
        path: ["kind"],
        message: `kind must be one of ${allowed.join(", ")} when level is ${record.level}`,
      });
    }
  });
export type Attention = z.output<typeof attentionSchema>;

/**
 * `GET /v1/projects/:id/snapshot`. `state` is the domain's ProjectState; it is opaque here so
 * the protocol does not depend on the domain package, which can narrow it with `.extend()`.
 */
export const snapshotResponseSchema = z.strictObject({
  projectId: idSchema,
  cursor: nonNegativeIntSchema,
  reducerVersion: nonNegativeIntSchema,
  stateHash: z.string().min(1),
  state: z.record(z.string(), z.unknown()),
  attention: z.array(attentionSchema),
  computedAt: timestampSchema,
});
export type SnapshotResponse = z.output<typeof snapshotResponseSchema>;

/** Max pairing code length the engine accepts (`apps/engine`, M1.10). */
export const PAIRING_CODE_MAX_LENGTH = 256;

export const pairingRequestSchema = z.strictObject({
  code: z.string().min(1).max(PAIRING_CODE_MAX_LENGTH),
});
export const pairingResponseSchema = z.strictObject({ session: z.string().min(1) });
export const pairingRevokeResponseSchema = z.strictObject({ revoked: nonNegativeIntSchema });
export type PairingRequest = z.output<typeof pairingRequestSchema>;
export type PairingResponse = z.output<typeof pairingResponseSchema>;
export type PairingRevokeResponse = z.output<typeof pairingRevokeResponseSchema>;

/**
 * `GET /health`: `200` with `status: "ok"`, `503` with `db: "error"`. http-api.md lists every
 * field, but `db` and `walMode` are absent until the engine has storage wired in, and `version`
 * when none is configured, so they are optional here.
 */
export const healthResponseSchema = z.strictObject({
  status: z.enum(["ok", "error"]),
  db: z.enum(["ok", "error"]).optional(),
  walMode: z.boolean().optional(),
  uptimeSeconds: z.number().nonnegative(),
  version: z.string().min(1).optional(),
});
export type HealthResponse = z.output<typeof healthResponseSchema>;
