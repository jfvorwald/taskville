import type { Hono } from "hono";
import type { Logger } from "pino";
import {
  type CommandService,
  createCommandService,
  registerCommandRoutes,
} from "../commands/index.ts";
import { defaultExecFile, type OpenSessionExecFile } from "../commands/open-session.ts";
import type { TaskvilleConfig } from "../config/config.ts";
import type { AppEnv } from "../http/app.ts";
import type { Engine } from "../stream/index.ts";
import { createPermissionBridge, type PermissionBridge } from "./bridge.ts";
import { registerRequestInputRoute } from "./input-route.ts";
import { registerBridgeRoutes } from "./route.ts";

export interface WirePermissionBridgeOptions {
  /** The Hono app from `createApp`; the routes are registered on it. */
  app: Hono<AppEnv>;
  /** The booted engine; its storage and stream hub are used. */
  engine: Pick<Engine, "storage" | "hub">;
  /** The hold window comes from `bridge.holdWindowSeconds`; the opener from `sessionOpener`. */
  config: Pick<TaskvilleConfig, "bridge" | "sessionOpener">;
  /** Runs the session opener. Defaults to the real detached spawn. */
  execFile?: OpenSessionExecFile;
  schedule?: (run: () => void, delayMs: number) => () => void;
  monotonicNowMs?: () => number;
  now?: () => Date;
  logger?: Logger;
}

export interface WiredPermissionBridge {
  bridge: PermissionBridge;
  commands: CommandService;
  /** Hands a telemetry hook to the bridge (`bridge.observeHook`). */
  observeHook(payload: unknown): void;
  /** Releases every held hook response with an empty 2xx (engine shutdown). */
  close(): void;
}

/**
 * Composes the permission bridge, the command service, and the request-input route onto an app
 * (ARCHITECTURE.md 8.1 and 9). Registers `POST /v1/bridge/claude-code/permission`, the real
 * `POST /v1/commands` and `GET /v1/commands/:id` (retiring the 501 stub), and
 * `GET /v1/requests/:requestId/input`.
 */
export function wirePermissionBridge(options: WirePermissionBridgeOptions): WiredPermissionBridge {
  const { app, engine, config } = options;
  const bridge = createPermissionBridge({
    storage: engine.storage,
    hub: engine.hub,
    holdWindowMs: config.bridge.holdWindowSeconds * 1000,
    ...(options.schedule ? { schedule: options.schedule } : {}),
    ...(options.monotonicNowMs ? { monotonicNowMs: options.monotonicNowMs } : {}),
    ...(options.now ? { now: options.now } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  const commands = createCommandService({
    engine,
    bridge,
    opener: {
      config: { sessionOpener: config.sessionOpener },
      execFile: options.execFile ?? defaultExecFile,
    },
    ...(options.now ? { now: options.now } : {}),
    ...(options.logger ? { logger: options.logger } : {}),
  });
  registerBridgeRoutes(app, bridge);
  registerCommandRoutes(app, commands);
  registerRequestInputRoute(app, bridge, engine.storage);
  return {
    bridge,
    commands,
    observeHook: (payload) => bridge.observeHook(payload),
    close: () => bridge.close(),
  };
}
