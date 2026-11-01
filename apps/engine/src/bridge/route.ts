import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../http/app.ts";
import { apiError } from "../http/errors.ts";
import type { PermissionBridge } from "./bridge.ts";

export const BRIDGE_PERMISSION_PATH = "/v1/bridge/claude-code/permission";

/** A hook body over 1 MiB is refused with 413; a held request keeps at most 256 KiB of input. */
const MAX_HOOK_BODY_BYTES = 1024 * 1024;

/**
 * `POST /v1/bridge/claude-code/permission` (ARCHITECTURE.md 8.1): the PermissionRequest `http`
 * hook. Registered on the app from `createApp`, so the Host, Origin, and credential middleware
 * already ran; the `bridge` scope admits the bridge token only, never the CLI token or a browser
 * session. The response is held until a city decision, the hold window, or a terminal answer;
 * 200 with the hook JSON, or 200 with an empty body to fall through to Claude Code's own dialog.
 * A body that is not a JSON object with a session and a tool is 400, and one over 1 MiB is 413.
 */
export function registerBridgeRoutes(app: Hono<AppEnv>, bridge: PermissionBridge): void {
  app.post(
    BRIDGE_PERMISSION_PATH,
    requireScope("bridge"),
    bodyLimit({
      maxSize: MAX_HOOK_BODY_BYTES,
      onError: (c) => apiError(c, 413, "payload_too_large", "Hook body is over 1 MiB"),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const response = await bridge.handle(body, c.req.raw.signal);
      return (
        response ?? apiError(c, 400, "bad_request", "Expected a PermissionRequest hook JSON object")
      );
    },
  );
}
