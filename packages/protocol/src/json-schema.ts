import { z } from "zod";
import { apiErrorSchema, eventBatchRequestSchema, eventBatchResponseSchema } from "./api.ts";
import { inputEventSchema, storedEnvelopeSchema } from "./envelope.ts";
import { isEventType, requiredEnvelopeIds } from "./event-types.ts";
import { ingestResultSchema } from "./ingest.ts";
import { sseFrameSchema } from "./sse.ts";

// JSON Schema documents for adapter authors (research.md R-4). Input documents describe what a
// producer may send (any string for open enums); output documents describe what the engine sends.

const documents = {
  "input-event": { schema: inputEventSchema, io: "input" },
  "event-batch-request": { schema: eventBatchRequestSchema, io: "input" },
  "stored-envelope": { schema: storedEnvelopeSchema, io: "output" },
  "ingest-result": { schema: ingestResultSchema, io: "output" },
  "event-batch-response": { schema: eventBatchResponseSchema, io: "output" },
  "api-error": { schema: apiErrorSchema, io: "output" },
  "sse-frame": { schema: sseFrameSchema, io: "output" },
} as const satisfies Record<string, { schema: z.ZodType; io: "input" | "output" }>;

export type JsonSchemaName = keyof typeof documents;

/**
 * Envelope IDs a type requires are checked by a refinement, which JSON Schema cannot express, so
 * they are added to the `required` list of every event member, at any depth (the SSE frame
 * document nests stored envelopes).
 */
function withRequiredEnvelopeIds(node: unknown): unknown {
  if (Array.isArray(node)) return node.map(withRequiredEnvelopeIds);
  if (typeof node !== "object" || node === null) return node;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node)) out[key] = withRequiredEnvelopeIds(value);
  const properties = out.properties as { type?: { const?: unknown } } | undefined;
  const type = properties?.type?.const;
  if (typeof type === "string" && isEventType(type) && Array.isArray(out.required)) {
    out.required = [...new Set([...(out.required as string[]), ...requiredEnvelopeIds(type)])];
  }
  return out;
}

export type JsonSchemaDocument = Record<string, unknown> & { $schema: string; $id: string };

/** Builds every published JSON Schema document (draft 2020-12), keyed by name. */
export function buildJsonSchemas(): Record<JsonSchemaName, JsonSchemaDocument> {
  const out = {} as Record<JsonSchemaName, JsonSchemaDocument>;
  for (const [name, { schema, io }] of Object.entries(documents) as [
    JsonSchemaName,
    (typeof documents)[JsonSchemaName],
  ][]) {
    const generated = z.toJSONSchema(schema, { io, target: "draft-2020-12" });
    const { $schema: _, ...rest } = withRequiredEnvelopeIds(generated) as Record<string, unknown>;
    out[name] = {
      $schema: "https://json-schema.org/draft/2020-12/schema",
      $id: `urn:taskville:protocol:v1:${name}`,
      ...rest,
    };
  }
  return out;
}
