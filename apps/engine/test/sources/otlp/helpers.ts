import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Hono } from "hono";
import type { AppEnv } from "../../../src/http/app.ts";
import { BRIDGE_TOKEN, bearer, CLI_TOKEN, makeApp, postJson } from "../../http/helpers.ts";

// M5.12 (#104) pins `registerOtlpRoutes` in apps/engine/src/sources/otlp/index.ts:
//
//   registerOtlpRoutes(app: Hono<AppEnv>, options?: { ledger?: CostLedger }): CostLedger
//
// It is loaded by a computed path, and only when the file exists, so that before the
// implementation exists the suite fails on the missing routes (404 instead of 200), not on an
// import error that hides every assertion (the M5.01 pattern).
const OTLP_MODULE_PATH = join(import.meta.dirname, "../../../src/sources/otlp/index.ts");
const OTLP_MODULE_SPECIFIER = "../../../src/sources/otlp/index.ts";

export const BASE = "http://127.0.0.1:4807";
export const METRICS_URL = `${BASE}/v1/otlp/v1/metrics`;
export const LOGS_URL = `${BASE}/v1/otlp/v1/logs`;
export const FIXTURES = join(import.meta.dirname, "../../../../../fixtures/otlp");

export type RegisterOtlpRoutes = (app: Hono<AppEnv>, options?: object) => unknown;

export async function loadRegisterOtlpRoutes(): Promise<RegisterOtlpRoutes | undefined> {
  if (!existsSync(OTLP_MODULE_PATH)) return undefined;
  const mod = (await import(/* @vite-ignore */ OTLP_MODULE_SPECIFIER)) as {
    registerOtlpRoutes?: RegisterOtlpRoutes;
  };
  return mod.registerOtlpRoutes;
}

/** The real app (Host, Origin and credential middleware) with the OTLP routes registered. */
export async function makeOtlpApp() {
  const made = makeApp();
  const register = await loadRegisterOtlpRoutes();
  register?.(made.app);
  return made;
}

export const fixture = (name: string): Record<string, unknown> =>
  JSON.parse(readFileSync(join(FIXTURES, name), "utf8")) as Record<string, unknown>;

type App = ReturnType<typeof makeApp>["app"];

export const sendMetrics = (app: App, body: unknown, headers = bearer(CLI_TOKEN)) =>
  Promise.resolve(app.request(METRICS_URL, postJson(body, headers)));
export const sendLogs = (app: App, body: unknown, headers = bearer(CLI_TOKEN)) =>
  Promise.resolve(app.request(LOGS_URL, postJson(body, headers)));

export interface CostReply {
  agentId: string;
  parentAgentId?: string;
  tokens: { input: number; output: number; cacheRead: number; cacheCreation: number };
  costUsd: number;
}

export const costOf = (app: App, agentId: string, headers = bearer(CLI_TOKEN)) =>
  Promise.resolve(
    app.request(`${BASE}/v1/agents/${encodeURIComponent(agentId)}/cost`, { headers }),
  );

/** Reads an agent's cost with the CLI token; fails with the status when there is none. */
export async function readCost(app: App, agentId: string): Promise<CostReply> {
  const res = await costOf(app, agentId);
  if (res.status !== 200) throw new Error(`cost for ${agentId} answered ${res.status}`);
  return (await res.json()) as CostReply;
}

// Agent IDs are the Claude Code adapter's attribution: claude-code:<session_id>[:<agent_id>].
export const PARALLEL_SESSION = "1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
export const PARALLEL = {
  lead: `claude-code:${PARALLEL_SESSION}`,
  a: `claude-code:${PARALLEL_SESSION}:afdf84bea07a9064c`,
  b: `claude-code:${PARALLEL_SESSION}:a0b4668e13e056653`,
} as const;
export const NESTED = {
  lead: "claude-code:6effc000-24c8-436e-ae5e-33152b820f83",
  outer: "claude-code:6effc000-24c8-436e-ae5e-33152b820f83:ac5497782768787b9",
  inner: "claude-code:6effc000-24c8-436e-ae5e-33152b820f83:a0c1bc9a2c30e80b6",
} as const;
export const LOGS_ONLY = "claude-code:5c2f7a10-3b6d-4e0a-9f1e-0a7d2c9b8e41:a7e3d1c9b5f20486a";

export { BRIDGE_TOKEN, bearer, CLI_TOKEN };
