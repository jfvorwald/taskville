import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";

export type ErrorCode =
  | "bad_request"
  | "credential_not_allowed"
  | "forbidden_host"
  | "forbidden_origin"
  | "internal"
  | "invalid_pairing_code"
  | "not_found"
  | "not_implemented"
  | "payload_too_large"
  | "unauthorized";

/** The API error shape: `{ "error": { "code", "message" } }`. Messages never carry request values. */
export function apiError(
  c: Context,
  status: ContentfulStatusCode,
  code: ErrorCode,
  message: string,
) {
  return c.json({ error: { code, message } }, status);
}
