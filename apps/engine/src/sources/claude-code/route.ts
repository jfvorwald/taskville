import { MAX_BATCH_BYTES } from "@taskville/protocol";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../../http/app.ts";
import { apiError } from "../../http/errors.ts";
import type { ClaudeCodeSource, HookIngestResponse } from "./source.ts";

export const CLAUDE_CODE_HOOKS_PATH = "/v1/sources/claude-code/hooks";
/** The batch route's byte limit (contracts/http-api.md): one hook is never larger than a batch. */
export const MAX_HOOK_BODY_BYTES = MAX_BATCH_BYTES;
/**
 * The only `sourceEventId` the route and the spool replay accept: a lowercase UUID v4, exactly
 * what the shim generates (M2.01). The mappers build event and request IDs from it unmasked, so
 * anything else (a secret-shaped string, roborev 5161) is refused rather than logged. At 36
 * characters it is well under the mappers' limit (`MAX_SOURCE_EVENT_ID` in
 * `@taskville/adapters/claude-code`, the one source of truth). JavaScript's `$` never matches
 * before a trailing newline (L-41).
 */
export const SHIM_SOURCE_EVENT_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export function isShimSourceEventId(value: unknown): value is string {
  return typeof value === "string" && SHIM_SOURCE_EVENT_ID.test(value);
}

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
  if (!isShimSourceEventId(body.sourceEventId)) return undefined;
  if (!isPlainRecord(body.payload)) return undefined;
  return { sourceEventId: body.sourceEventId, payload: body.payload };
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export interface ClaudeCodeRouteOptions {
  /**
   * Called with the raw payload of each accepted hook (at least one `accepted` event, not
   * `ignored`), after its events committed. M4.04 passes the permission bridge's `observeHook`.
   */
  observeHook?: (payload: Record<string, unknown>) => void;
}

function isAccepted(response: HookIngestResponse): boolean {
  return response.ignored !== true && response.results.some((r) => r.status === "accepted");
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
export function registerClaudeCodeRoutes(
  app: Hono<AppEnv>,
  source: ClaudeCodeSource,
  options: ClaudeCodeRouteOptions = {},
): void {
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
          "Expected { sourceEventId: string of 1 to 170 characters, payload: object }",
        );
      }
      const response = await source.ingestHook(wrapper);
      if (options.observeHook !== undefined && isAccepted(response)) {
        // The observer is a side channel (the permission bridge closing a request): it cannot
        // fail a hook whose events are already committed.
        try {
          options.observeHook(wrapper.payload);
        } catch {
          // Nothing to record here: the error could echo the hook's content.
        }
      }
      return c.json(response);
    },
  );
}
