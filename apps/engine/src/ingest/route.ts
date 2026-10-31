import { eventBatchRequestSchema, MAX_BATCH_BYTES, MAX_BATCH_EVENTS } from "@taskville/protocol";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import type { IngestPipeline } from "./pipeline.ts";

/**
 * `POST /v1/events/batch` (contracts/http-api.md). Registered on the app from
 * `createApp`, so the Host, Origin, and credential middleware already ran; the
 * `ingest` scope admits the CLI and shim token only, never a browser session or
 * the bridge token. A body that is not a batch is 400, over 5 MB or 5,000
 * events is 413, and anything else is 200 with per-event results.
 */
export function registerIngestRoute(app: Hono<AppEnv>, pipeline: IngestPipeline): void {
  app.post(
    "/v1/events/batch",
    requireScope("ingest"),
    bodyLimit({
      maxSize: MAX_BATCH_BYTES,
      onError: (c) => apiError(c, 413, "payload_too_large", "Batch body is over 5 MB"),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = eventBatchRequestSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(c, 400, "bad_request", "Expected { events: InputEvent[] }");
      }
      if (parsed.data.events.length > MAX_BATCH_EVENTS) {
        return apiError(c, 413, "payload_too_large", "Batch has more than 5,000 events");
      }
      return c.json(pipeline.ingest(parsed.data.events));
    },
  );
}
