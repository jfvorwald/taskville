import { importRequestSchema } from "@taskville/protocol";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import { type ImportJobs, ImportRefusal, type ImportRefusalCode } from "./jobs.ts";

const REFUSALS: Record<ImportRefusalCode, { status: 400 | 404 | 409 | 503; message: string }> = {
  engine_closing: { status: 503, message: "The engine is shutting down" },
  unknown_import_kind: { status: 400, message: "No importer for this kind" },
  unknown_project: { status: 404, message: "No project with this ID" },
  root_not_configured: { status: 400, message: "Root is not one of the project's roots" },
  import_running: { status: 409, message: "This project already has a running import" },
};

/**
 * `POST /v1/imports` (CLI token only; the `imports` scope) and `GET /v1/imports/:id` (CLI token or
 * paired session). Registered on the app from `createApp`, so the Host, Origin and credential
 * checks run first. Imports run off the request; the answer to POST is `202`.
 */
export function registerImportRoutes(app: Hono<AppEnv>, jobs: ImportJobs): void {
  app.post(
    "/v1/imports",
    requireScope("imports"),
    bodyLimit({
      maxSize: 64 * 1024,
      onError: (c) => apiError(c, 413, "payload_too_large", "Body too large"),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = importRequestSchema.safeParse(body);
      if (!parsed.success) {
        return apiError(c, 400, "bad_request", "Expected { projectId, kind, root }");
      }
      try {
        return c.json(jobs.start(parsed.data), 202);
      } catch (error) {
        if (!(error instanceof ImportRefusal)) throw error;
        const refusal = REFUSALS[error.code];
        return apiError(c, refusal.status, error.code, refusal.message);
      }
    },
  );

  app.get("/v1/imports/:id", requireScope("read"), (c) => {
    const status = jobs.status(c.req.param("id"));
    if (status === undefined) return apiError(c, 404, "not_found", "No import with this ID");
    return c.json(status);
  });
}
