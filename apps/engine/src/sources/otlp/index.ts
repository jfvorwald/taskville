// Optional OpenTelemetry receiver (M5.12, ARCHITECTURE.md 5.1 and 10): Claude Code's OTLP/HTTP
// JSON export of tokens and cost, kept in an in-memory ledger keyed by agent ID and read back with
// `GET /v1/agents/:id/cost`. Telemetry is a counter, not a fact the world replays, so nothing
// here touches the event log or the reducer. Payload bodies and attribute values are never logged.
import { MAX_BATCH_BYTES } from "@taskville/protocol";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { type AppEnv, requireScope } from "../../http/app.ts";
import { apiError } from "../../http/errors.ts";

export const OTLP_METRICS_PATH = "/v1/otlp/v1/metrics";
export const OTLP_LOGS_PATH = "/v1/otlp/v1/logs";
/** Agents the ledger keeps; further new agents are ignored rather than growing without bound. */
export const MAX_LEDGER_AGENTS = 10_000;

export interface CostTokens {
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
}

export interface AgentCost {
  agentId: string;
  parentAgentId?: string;
  tokens: CostTokens;
  costUsd: number;
}

interface Totals {
  seen: boolean;
  tokens: CostTokens;
  costUsd: number;
}

interface Entry {
  parentAgentId?: string;
  metrics: Totals;
  logs: Totals;
}

const emptyTotals = (): Totals => ({
  seen: false,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  costUsd: 0,
});

/** Tokens and cost per agent, in memory. Metrics win over logs so spend is never counted twice. */
export class CostLedger {
  readonly #entries = new Map<string, Entry>();

  /** @internal */
  entry(agentId: string, parentAgentId: string | undefined): Entry | undefined {
    let entry = this.#entries.get(agentId);
    if (entry === undefined) {
      if (this.#entries.size >= MAX_LEDGER_AGENTS) return undefined;
      entry = { metrics: emptyTotals(), logs: emptyTotals() };
      this.#entries.set(agentId, entry);
    }
    if (parentAgentId !== undefined) entry.parentAgentId = parentAgentId;
    return entry;
  }

  get(agentId: string): AgentCost | undefined {
    const entry = this.#entries.get(agentId);
    if (entry === undefined) return undefined;
    const totals = entry.metrics.seen ? entry.metrics : entry.logs.seen ? entry.logs : undefined;
    if (totals === undefined) return undefined;
    return {
      agentId,
      ...(entry.parentAgentId === undefined ? {} : { parentAgentId: entry.parentAgentId }),
      tokens: { ...totals.tokens },
      costUsd: totals.costUsd,
    };
  }
}

type Json = Record<string, unknown>;
const isRecord = (value: unknown): value is Json =>
  typeof value === "object" && value !== null && !Array.isArray(value);
const list = (value: unknown): Json[] => (Array.isArray(value) ? value.filter(isRecord) : []);

/** OTLP attributes as a map of plain values (string, or a finite number from int or double). */
function attributes(raw: unknown): Map<string, string | number> {
  const out = new Map<string, string | number>();
  for (const item of list(raw)) {
    const value = item.value;
    if (typeof item.key !== "string" || !isRecord(value)) continue;
    if (typeof value.stringValue === "string") out.set(item.key, value.stringValue);
    else {
      const n = number(value.intValue ?? value.doubleValue);
      if (n !== undefined) out.set(item.key, n);
    }
  }
  return out;
}

/** int64 arrives as a string or a number, doubles as numbers; only finite values count. */
function number(value: unknown): number | undefined {
  const n = typeof value === "string" && value.trim() !== "" ? Number(value) : value;
  return typeof n === "number" && Number.isFinite(n) && n >= 0 ? n : undefined;
}

function text(attrs: Map<string, string | number>, key: string): string | undefined {
  const value = attrs.get(key);
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** `claude-code:<session.id>[:<agent_id>]`, the adapters' agent IDs; undefined without a session. */
function agentOf(attrs: Map<string, string | number>): string | undefined {
  const session = text(attrs, "session.id");
  if (session === undefined) return undefined;
  const agent = text(attrs, "agent_id");
  return agent === undefined ? `claude-code:${session}` : `claude-code:${session}:${agent}`;
}

const TOKEN_TYPES: ReadonlySet<string> = new Set(["input", "output", "cacheRead", "cacheCreation"]);

function ingestMetrics(ledger: CostLedger, body: Json): void {
  for (const resource of list(body.resourceMetrics)) {
    for (const scope of list(resource.scopeMetrics)) {
      for (const metric of list(scope.metrics)) {
        const isTokens = metric.name === "claude_code.token.usage";
        if (!isTokens && metric.name !== "claude_code.cost.usage") continue;
        const points = list(
          (isRecord(metric.sum) ? metric.sum : (metric.gauge as Json))?.dataPoints,
        );
        for (const point of points) {
          const attrs = attributes(point.attributes);
          const agentId = agentOf(attrs);
          const value = number(point.asInt ?? point.asDouble);
          if (agentId === undefined || value === undefined) continue;
          const type = text(attrs, "type");
          if (isTokens && (type === undefined || !TOKEN_TYPES.has(type))) continue;
          const entry = ledger.entry(agentId, text(attrs, "parent_agent_id"));
          if (entry === undefined) continue;
          entry.metrics.seen = true;
          if (isTokens) entry.metrics.tokens[type as keyof CostTokens] += value;
          else entry.metrics.costUsd += value;
        }
      }
    }
  }
}

function ingestLogs(ledger: CostLedger, body: Json): void {
  for (const resource of list(body.resourceLogs)) {
    for (const scope of list(resource.scopeLogs)) {
      for (const record of list(scope.logRecords)) {
        const attrs = attributes(record.attributes);
        if (attrs.get("event.name") !== "claude_code.api_request") continue;
        const agentId = agentOf(attrs);
        if (agentId === undefined) continue;
        const entry = ledger.entry(agentId, text(attrs, "parent_agent_id"));
        if (entry === undefined) continue;
        const logs = entry.logs;
        logs.seen = true;
        const num = (key: string) => number(attrs.get(key)) ?? 0;
        logs.tokens.input += num("input_tokens");
        logs.tokens.output += num("output_tokens");
        logs.tokens.cacheRead += num("cache_read_tokens");
        logs.tokens.cacheCreation += num("cache_creation_tokens");
        logs.costUsd += num("cost_usd");
      }
    }
  }
}

export interface OtlpRouteOptions {
  ledger?: CostLedger;
}

/**
 * `POST /v1/otlp/v1/metrics` and `/logs` (scope `ingest`, the CLI token only; 5 MB; JSON only) and
 * `GET /v1/agents/:id/cost` (scope `read`). Registered on the app from `createApp`, so the Host,
 * Origin and credential middleware already ran. Errors never echo the input.
 */
export function registerOtlpRoutes(app: Hono<AppEnv>, options: OtlpRouteOptions = {}): CostLedger {
  const ledger = options.ledger ?? new CostLedger();
  const receive = (path: string, ingest: (ledger: CostLedger, body: Json) => void) =>
    app.post(
      path,
      requireScope("ingest"),
      bodyLimit({
        maxSize: MAX_BATCH_BYTES,
        onError: (c) => apiError(c, 413, "payload_too_large", "Body is over 5 MB"),
      }),
      async (c) => {
        const type = (c.req.header("content-type") ?? "").split(";")[0]?.trim().toLowerCase();
        if (type !== "application/json") {
          return c.json(
            { error: { code: "unsupported_media_type", message: "Send OTLP as application/json" } },
            415,
          );
        }
        const body: unknown = await c.req.json().catch(() => undefined);
        if (
          !isRecord(body) ||
          (body.resourceMetrics !== undefined && !Array.isArray(body.resourceMetrics)) ||
          (body.resourceLogs !== undefined && !Array.isArray(body.resourceLogs))
        ) {
          return apiError(c, 400, "bad_request", "Expected an OTLP/HTTP JSON export");
        }
        ingest(ledger, body);
        return c.json({});
      },
    );
  receive(OTLP_METRICS_PATH, ingestMetrics);
  receive(OTLP_LOGS_PATH, ingestLogs);
  app.get("/v1/agents/:id/cost", requireScope("read"), (c) => {
    const cost = ledger.get(c.req.param("id"));
    if (cost === undefined) {
      return c.json(
        { error: { code: "no_cost", message: "No telemetry reported cost for this agent" } },
        404,
      );
    }
    return c.json(cost);
  });
  return ledger;
}
