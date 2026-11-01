import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AppEnv, markCommandRoutesRegistered, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import type { CommandService } from "./service.ts";

/** A command body is a few short fields; anything near this size is not one. */
const MAX_COMMAND_BODY_BYTES = 16 * 1024;

/**
 * `POST /v1/commands` and `GET /v1/commands/:id`. Registered on the app from `createApp`, so the
 * Host, Origin, and credential middleware already ran; the `command` scope admits a paired
 * browser session only, never the CLI, shim, or bridge token (ARCHITECTURE.md 9.2). Registering
 * these retires the `501` stub `createApp` carries until the service exists.
 */
export function registerCommandRoutes(app: Hono<AppEnv>, service: CommandService): void {
  markCommandRoutesRegistered(app);
  app.post(
    "/v1/commands",
    requireScope("command"),
    bodyLimit({
      maxSize: MAX_COMMAND_BODY_BYTES,
      onError: (c) => apiError(c, 413, "payload_too_large", "Command body is too large"),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const result = await service.submit(body);
      return c.json(result.body, result.status as ContentfulStatusCode);
    },
  );
  app.get("/v1/commands/:id", requireScope("command"), (c) => {
    const result = service.get(c.req.param("id"));
    return c.json(result.body, result.status as ContentfulStatusCode);
  });
}
