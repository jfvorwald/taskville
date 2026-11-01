import type { ProjectState } from "@taskville/domain/reducer";
import type { Context, Hono } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import type { Storage } from "../storage/index.ts";
import type { PermissionBridge } from "./bridge.ts";

export const REQUEST_INPUT_PATH = "/v1/requests/:requestId/input";

const MESSAGES = {
  unknown_request: "No such request",
  request_expired: "The request can no longer be answered here",
} as const;

function refuse(c: Context, status: ContentfulStatusCode, code: keyof typeof MESSAGES) {
  return c.json({ error: { code, message: MESSAGES[code] } }, status);
}

/**
 * `GET /v1/requests/:requestId/input?projectId=` (ARCHITECTURE.md 9): the exact, unmasked tool
 * input of a request whose hook response the bridge still holds, for the decision card. The
 * `command` scope admits a paired browser session only (never the CLI, shim, or bridge token),
 * the app's `/v1/*` middleware sets `Cache-Control: no-store`, and no CORS header is ever added.
 * 400 without a project; 404 for an unknown request or one in another project; 410 for a request
 * that is recorded but no longer held (decided, window over, closed by PostToolUse, or never
 * held). The input is never logged and never appears in an error.
 */
export function registerRequestInputRoute(
  app: Hono<AppEnv>,
  bridge: PermissionBridge,
  storage: Pick<Storage, "projection">,
): void {
  app.get(REQUEST_INPUT_PATH, requireScope("command"), (c) => {
    const projectId = c.req.query("projectId");
    if (projectId === undefined || projectId === "") {
      return apiError(c, 400, "bad_request", "Expected a projectId query parameter");
    }
    const requestId = c.req.param("requestId");
    const held = bridge.lookup(requestId);
    if (held !== undefined) {
      if (held.projectId !== projectId) return refuse(c, 404, "unknown_request");
      return c.json({
        requestId: held.requestId,
        projectId: held.projectId,
        sessionId: held.sessionId,
        toolName: held.toolName,
        toolInput: held.toolInput,
        ...(held.cwd === undefined ? {} : { cwd: held.cwd }),
      });
    }
    const state = storage.projection<ProjectState>(projectId)?.state;
    if (state === undefined || !Object.hasOwn(state.requests, requestId)) {
      return refuse(c, 404, "unknown_request");
    }
    return refuse(c, 410, "request_expired");
  });
}
