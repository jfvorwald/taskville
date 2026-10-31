import type { MiddlewareHandler } from "hono";
import type { Logger } from "pino";
import type { PairingStore } from "../auth/pairing.ts";
import { allows, type CredentialKind, type Scope } from "../auth/scopes.ts";
import { safeEqual } from "../auth/secrets.ts";
import { apiError } from "./errors.ts";

export type AppEnv = { Variables: { credential: CredentialKind | null } };

const STATE_CHANGING = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const BEARER = /^Bearer\s+(\S+)$/i;

/** One structured line per request. Logs method, path (no query), status and duration only. */
export function accessLog(logger: Logger): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const started = performance.now();
    await next();
    logger.info(
      {
        method: c.req.method,
        path: c.req.path,
        status: c.res.status,
        ms: Math.round(performance.now() - started),
      },
      "request",
    );
  };
}

/** Rejects any request whose Host is not the loopback host and port (blocks DNS rebinding). */
export function hostCheck(allowedHosts: ReadonlySet<string>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const host = c.req.header("host")?.toLowerCase();
    if (host === undefined || !allowedHosts.has(host)) {
      return apiError(c, 403, "forbidden_host", "Host header is not the engine's loopback address");
    }
    return next();
  };
}

/**
 * Resolves the request's credential, if any, and rejects a credential that is
 * presented but invalid. Sending both a bearer token and a session is refused.
 */
export function authenticate(opts: {
  cliToken: string;
  bridgeToken: string;
  pairing: PairingStore;
}): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const authorization = c.req.header("authorization");
    const session = c.req.header("x-taskville-session");
    let credential: CredentialKind | null = null;
    if (authorization !== undefined && session !== undefined) {
      return apiError(c, 401, "unauthorized", "Send one credential, not both");
    }
    if (authorization !== undefined) {
      const token = BEARER.exec(authorization)?.[1];
      if (token === undefined)
        return apiError(c, 401, "unauthorized", "Malformed Authorization header");
      const isCli = safeEqual(token, opts.cliToken);
      const isBridge = safeEqual(token, opts.bridgeToken);
      credential = isCli ? "cli" : isBridge ? "bridge" : null;
      if (credential === null) return apiError(c, 401, "unauthorized", "Invalid token");
    } else if (session !== undefined) {
      if (!opts.pairing.hasSession(session)) {
        return apiError(c, 401, "unauthorized", "Unknown or revoked session");
      }
      credential = "session";
    }
    c.set("credential", credential);
    return next();
  };
}

/**
 * Origin rules. Any request carrying an Origin must carry an allowed one.
 * A state-changing request that does not use a bearer token (a browser
 * session, or the unauthenticated pairing exchange) must carry an allowed
 * Origin. Runs after `authenticate`.
 */
export function originCheck(allowedOrigins: ReadonlySet<string>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const origin = c.req.header("origin");
    if (origin !== undefined && !allowedOrigins.has(origin.toLowerCase())) {
      return apiError(c, 403, "forbidden_origin", "Origin is not allowed");
    }
    const credential = c.get("credential");
    const usesToken = credential === "cli" || credential === "bridge";
    if (STATE_CHANGING.has(c.req.method) && !usesToken && origin === undefined) {
      return apiError(c, 403, "forbidden_origin", "Origin header required");
    }
    return next();
  };
}

/** Default deny for the API: every `/v1/*` route needs a credential unless listed in `publicRoutes`. */
export function requireCredential(publicRoutes: ReadonlySet<string>): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    if (publicRoutes.has(`${c.req.method} ${c.req.path}`)) return next();
    if (c.get("credential") === null)
      return apiError(c, 401, "unauthorized", "Credentials required");
    return next();
  };
}

/** Route guard: the request's credential must be granted `scope`. */
export function requireScope(scope: Scope): MiddlewareHandler<AppEnv> {
  return async (c, next) => {
    const credential = c.get("credential");
    if (credential === null) return apiError(c, 401, "unauthorized", "Credentials required");
    if (!allows(credential, scope)) {
      return apiError(c, 403, "forbidden", "This credential cannot use this route");
    }
    return next();
  };
}

/** `Cache-Control: no-store` on API responses, so secrets and state are never cached. */
export const noStore: MiddlewareHandler<AppEnv> = async (c, next) => {
  await next();
  c.res.headers.set("Cache-Control", "no-store");
};
