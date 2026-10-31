import { serveStatic } from "@hono/node-server/serve-static";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { secureHeaders } from "hono/secure-headers";
import pino, { type Logger } from "pino";
import { z } from "zod";
import type { PairingStore } from "../auth/pairing.ts";
import { apiError } from "./errors.ts";
import {
  type AppEnv,
  accessLog,
  authenticate,
  hostCheck,
  noStore,
  originCheck,
  requireCredential,
  requireOrigin,
  requireScope,
} from "./middleware.ts";

export type { AppEnv } from "./middleware.ts";
export { requireScope } from "./middleware.ts";

export interface AppOptions {
  /** The port the engine listens on; Host and Origin checks pin to it. */
  port: number;
  /** Token from `$TASKVILLE_HOME/token`, used by the CLI and the telemetry shim. */
  cliToken: string;
  /** Separate token used only by the permission bridge. */
  bridgeToken: string;
  pairing: PairingStore;
  /** Directory of the built web client, served without credentials. */
  staticDir?: string;
  logger?: Logger;
  /** Storage health, supplied by the storage module. Without it /health reports the process only. */
  health?: () => { db: "ok" | "error"; walMode: boolean };
  version?: string;
}

const PAIRING_EXCHANGE = "/v1/pairing";
const PUBLIC_ROUTES: ReadonlySet<string> = new Set([`POST ${PAIRING_EXCHANGE}`]);

const ExchangeBody = z.strictObject({ code: z.string().min(1).max(256) });

/**
 * Builds the engine's Hono app with the security middleware applied to every
 * route, including routes other modules add to the returned app later: Host
 * check, credential resolution, Origin check, and default-deny on `/v1/*`.
 * Routes add `requireScope(...)` for their own grant.
 */
export function createApp(options: AppOptions): Hono<AppEnv> {
  const { port, cliToken, bridgeToken, pairing } = options;
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new RangeError("port must be an integer from 1 to 65535");
  }
  if (cliToken === bridgeToken) throw new Error("CLI and bridge tokens must differ");
  const logger = options.logger ?? pino({ level: "silent" });

  const app = new Hono<AppEnv>();
  app.use(accessLog(logger));
  app.use(secureHeaders({ strictTransportSecurity: false }));
  app.use(hostCheck(new Set([`127.0.0.1:${port}`, `localhost:${port}`])));
  app.use(originCheck(new Set([`http://127.0.0.1:${port}`, `http://localhost:${port}`])));
  app.use(authenticate({ cliToken, bridgeToken, pairing }));
  app.use("/v1/*", noStore, requireCredential(PUBLIC_ROUTES));
  app.use("/health", noStore);

  app.get("/health", requireScope("read"), (c) => {
    const storage = options.health?.();
    const healthy = storage === undefined || storage.db === "ok";
    return c.json(
      {
        status: healthy ? "ok" : "error",
        ...storage,
        uptimeSeconds: Math.floor(process.uptime()),
        ...(options.version === undefined ? {} : { version: options.version }),
      },
      healthy ? 200 : 503,
    );
  });

  app.post(
    PAIRING_EXCHANGE,
    requireOrigin,
    bodyLimit({
      maxSize: 1024,
      onError: (c) => apiError(c, 413, "payload_too_large", "Body too large"),
    }),
    async (c) => {
      const body: unknown = await c.req.json().catch(() => undefined);
      const parsed = ExchangeBody.safeParse(body);
      if (!parsed.success) return apiError(c, 400, "bad_request", "Expected { code: string }");
      const session = pairing.exchange(parsed.data.code);
      if (session === null) {
        return apiError(
          c,
          401,
          "invalid_pairing_code",
          "Pairing code is invalid, used, or expired",
        );
      }
      logger.info("browser paired");
      return c.json({ session });
    },
  );

  app.post("/v1/pairing/revoke", requireScope("unpair"), (c) => {
    const revoked = pairing.unpairAll();
    logger.info({ revoked }, "browser pairings revoked");
    return c.json({ revoked });
  });

  // Command stub: the full credential rules apply now; the command service lands in M4.
  const notYet = (c: Context<AppEnv>) =>
    apiError(c, 501, "not_implemented", "Commands arrive with the command service (M4)");
  app.post("/v1/commands", requireScope("command"), notYet);
  app.get("/v1/commands/:id", requireScope("command"), notYet);

  if (options.staticDir !== undefined) {
    const files = serveStatic<AppEnv>({ root: options.staticDir });
    // API and health paths are never served from the static directory.
    app.get("*", (c, next) => (isApiPath(c.req.path) ? next() : files(c, next)));
  }

  app.notFound((c) => apiError(c, 404, "not_found", "Not found"));
  app.onError((err, c) => {
    // Name and stack frames only: an error message can echo request content.
    logger.error(
      { errName: err.name, stack: err.stack?.split("\n").slice(1).join("\n") },
      "unhandled",
    );
    return apiError(c, 500, "internal", "Internal error");
  });
  return app;
}

function isApiPath(path: string): boolean {
  return path === "/health" || path === "/v1" || path.startsWith("/v1/");
}
