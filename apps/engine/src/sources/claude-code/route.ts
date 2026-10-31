import { idSchema, MAX_BATCH_BYTES } from "@taskville/protocol";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../../http/app.ts";
import { apiError } from "../../http/errors.ts";
import type { ClaudeCodeSource } from "./source.ts";

export const CLAUDE_CODE_HOOKS_PATH = "/v1/sources/claude-code/hooks";
/** The batch route's byte limit (contracts/http-api.md): one hook is never larger than a batch. */
export const MAX_HOOK_BODY_BYTES = MAX_BATCH_BYTES;

const WRAPPER_KEYS: ReadonlySet<string> = new Set(["sourceEventId", "payload"]);

interface Wrapper {
  sourceEventId: string;
  payload: Record<string, unknown>;
}

/**
 * The shim's body (M2.01): exactly `{ sourceEventId, payload }`, read with
 * `Object.hasOwn` so a `__proto__` key is an unknown key, not a prototype.
 * Unknown keys are refused, which also means `late` cannot be set over HTTP.
 */
function parseWrapper(body: unknown): Wrapper | undefined {
  if (!isPlainRecord(body)) return undefined;
  if (!Object.keys(body).every((key) => WRAPPER_KEYS.has(key))) return undefined;
  if (!Object.hasOwn(body, "sourceEventId") || !Object.hasOwn(body, "payload")) return undefined;
  const id = idSchema.safeParse(body.sourceEventId);
  if (!id.success || !isPlainRecord(body.payload)) return undefined;
  return { sourceEventId: id.data, payload: body.payload };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * `POST /v1/sources/claude-code/hooks` (ARCHITECTURE.md 8.1): the telemetry
 * shim posts one raw hook as `{ sourceEventId, payload }` with the CLI token.
 * Registered on the app from `createApp`, so the Host, Origin, and credential
 * middleware already ran; the `ingest` scope admits the CLI token only, never
 * a browser session or the bridge token. The shim sends no Origin, which the
 * M1 Origin rules allow for bearer requests, so no rule is loosened here.
 *
 * 200 `{ projectId, results, heads, ignored? }` with per-event results as in
 * `POST /v1/events/batch`; 400 `bad_request` for any other body; 413
 * `payload_too_large` over 5 MB. Spooled hooks are not replayed through this
 * route: the spool (M2.07) calls `ClaudeCodeSource.ingestHook` with `late: true`.
 */
export function registerClaudeCodeRoutes(app: Hono<AppEnv>, source: ClaudeCodeSource): void {
  app.post(
    CLAUDE_CODE_HOOKS_PATH,
    requireScope("ingest"),
    bodyLimit({
      maxSize: MAX_HOOK_BODY_BYTES,
      onError: (c) => apiError(c, 413, "payload_too_large", "Hook body is over 5 MB"),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const wrapper = parseWrapper(body);
      if (wrapper === undefined) {
        return apiError(
          c,
          400,
          "bad_request",
          "Expected { sourceEventId: string, payload: object }",
        );
      }
      return c.json(await source.ingestHook(wrapper));
    },
  );
}
