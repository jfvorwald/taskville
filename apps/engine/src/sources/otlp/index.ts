// Optional OpenTelemetry receiver (M5.12, ARCHITECTURE.md 5.1 and 10): Claude Code's OTLP/HTTP
// JSON export of tokens and cost, kept in an in-memory ledger keyed by agent ID and read back with
// `GET /v1/agents/:id/cost`. Telemetry is a counter, not a fact the world replays, so nothing
// here touches the event log or the reducer. Payload bodies and attribute values are never logged.
import { createHash } from "node:crypto";
import { MAX_BATCH_BYTES } from "@taskville/protocol";
import type { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import type { Logger } from "pino";
import { type AppEnv, requireScope } from "../../http/app.ts";
import { apiError } from "../../http/errors.ts";
import type { SqliteOtlpCost } from "../../storage/otlp-cost.ts";
import { MAX_SEEN_DIGESTS } from "../../storage/otlp-cost.ts";
import type { Storage } from "../../storage/storage.ts";

export const OTLP_METRICS_PATH = "/v1/otlp/v1/metrics";
export const OTLP_LOGS_PATH = "/v1/otlp/v1/logs";
/** Agents the ledger keeps; further new agents are ignored rather than growing without bound. */
export const MAX_LEDGER_AGENTS = 10_000;
/** The longest session.id, agent_id or parent_agent_id kept; a longer one drops the data point. */
export const MAX_KEY_LENGTH = 256;
const MAX_SUM = Number.MAX_SAFE_INTEGER;
const add = (sum: number, value: number): number =>
  Math.min(MAX_SUM, sum + Math.min(MAX_SUM, value));

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
  /** Metrics only: which quantity the metrics reported, so each is chosen on its own. */
  seenTokens: boolean;
  seenCost: boolean;
  tokens: CostTokens;
  costUsd: number;
}

interface Entry {
  agentId: string;
  parentAgentId?: string;
  metrics: Totals;
  logs: Totals;
}

const emptyTotals = (): Totals => ({
  seen: false,
  seenTokens: false,
  seenCost: false,
  tokens: { input: 0, output: 0, cacheRead: 0, cacheCreation: 0 },
  costUsd: 0,
});

/**
 * Tokens and cost per agent. Metrics win over logs so spend is never counted twice. Held in memory
 * and, given a store (M5.29), written through to it and read back at construction. A data point
 * with a timestamp is counted once: its identity is remembered (the latest MAX_SEEN_DIGESTS).
 */
export class CostLedger {
  readonly #entries = new Map<string, Entry>();
  readonly #store: SqliteOtlpCost | undefined;
  readonly #maxAgents: number;
  readonly #seen = new Set<string>();
  #warned = false;

  constructor(store?: SqliteOtlpCost, maxAgents: number = MAX_LEDGER_AGENTS) {
    this.#store = store;
    this.#maxAgents = maxAgents;
    this.#load();
  }

  /** Fills the entries from the store, least recently updated first (the Map's insertion order). */
  #load(): void {
    this.#entries.clear();
    for (const row of this.#store?.load(this.#maxAgents) ?? []) {
      const totals = (t: typeof row.logs): CostTokens => ({
        input: t.input,
        output: t.output,
        cacheRead: t.cacheRead,
        cacheCreation: t.cacheCreation,
      });
      this.#entries.set(row.agentId, {
        agentId: row.agentId,
        ...(row.parentAgentId === undefined ? {} : { parentAgentId: row.parentAgentId }),
        metrics: {
          seen: row.metrics.seen,
          seenTokens: row.metrics.seenTokens,
          seenCost: row.metrics.seenCost,
          tokens: totals(row.metrics),
          costUsd: row.metrics.costUsd,
        },
        logs: {
          seen: row.logs.seen,
          seenTokens: false,
          seenCost: false,
          tokens: totals(row.logs),
          costUsd: row.logs.costUsd,
        },
      });
    }
  }

  /** True when the data point `identity` is new (and remembers it); false for a re-delivery. */
  claim(identity: string): boolean {
    const digest = createHash("sha256").update(identity).digest("hex");
    if (this.#store !== undefined) return this.#store.claim(digest);
    if (this.#seen.has(digest)) return false;
    this.#seen.add(digest);
    if (this.#seen.size > MAX_SEEN_DIGESTS) {
      this.#seen.delete(this.#seen.values().next().value as string);
    }
    return true;
  }

  /** Writes an entry through to the store, if any. */
  save(entry: Entry): void {
    const { metrics: m, logs: l } = entry;
    const row = (t: Totals) => ({ seen: t.seen, ...t.tokens, costUsd: t.costUsd });
    // Most recently updated last, matching the store's `last_seen`.
    this.#entries.delete(entry.agentId);
    this.#entries.set(entry.agentId, entry);
    this.#store?.save({
      agentId: entry.agentId,
      ...(entry.parentAgentId === undefined ? {} : { parentAgentId: entry.parentAgentId }),
      metrics: { ...row(m), seenTokens: m.seenTokens, seenCost: m.seenCost },
      logs: row(l),
    });
  }

  /** Runs one export's changes as a single store transaction. */
  batch<T>(work: () => T): T {
    if (this.#store === undefined) return work();
    try {
      return this.#store.transaction(work);
    } catch (error) {
      this.#load(); // the transaction rolled back, so memory must match the database again
      throw error;
    }
  }

  /** True once, the first time a new agent is refused because the ledger is full. */
  noteFull(): boolean {
    const first = !this.#warned;
    this.#warned = true;
    return first;
  }

  /** @internal */
  entry(agentId: string, parentAgentId: string | undefined): Entry | undefined {
    let entry = this.#entries.get(agentId);
    if (entry === undefined) {
      if (this.#entries.size >= this.#maxAgents) {
        // Full: the least recently updated agent makes room, in the store as well.
        const oldest = this.#entries.keys().next().value;
        if (oldest === undefined) return undefined;
        this.#entries.delete(oldest);
        this.#store?.evict(oldest);
      }
      entry = { agentId, metrics: emptyTotals(), logs: emptyTotals() };
      this.#entries.set(agentId, entry);
    }
    if (parentAgentId !== undefined) entry.parentAgentId = parentAgentId;
    return entry;
  }

  get(agentId: string): AgentCost | undefined {
    const entry = this.#entries.get(agentId);
    if (entry === undefined) return undefined;
    if (!entry.metrics.seen && !entry.logs.seen) return undefined;
    // Each quantity: the metric total when metrics reported it, else the logged sum, never both.
    const tokens = entry.metrics.seenTokens ? entry.metrics.tokens : entry.logs.tokens;
    const costUsd = entry.metrics.seenCost ? entry.metrics.costUsd : entry.logs.costUsd;
    return {
      agentId,
      ...(entry.parentAgentId === undefined ? {} : { parentAgentId: entry.parentAgentId }),
      tokens: { ...tokens },
      costUsd,
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

/**
 * `claude-code:<session.id>[:<agent_id>]`, the adapters' agent IDs. Undefined without a session;
 * "too_long" when a key is over MAX_KEY_LENGTH (the data point is refused and counted).
 */
function whoOf(
  attrs: Map<string, string | number>,
): { agentId: string; parent: string | undefined } | "too_long" | undefined {
  const session = text(attrs, "session.id");
  if (session === undefined) return undefined;
  const agent = text(attrs, "agent_id");
  const parent = text(attrs, "parent_agent_id");
  for (const key of [session, agent, parent]) {
    if (key !== undefined && (key.length > MAX_KEY_LENGTH || !key.isWellFormed())) {
      return "too_long";
    }
  }
  return {
    agentId: agent === undefined ? `claude-code:${session}` : `claude-code:${session}:${agent}`,
    parent,
  };
}

/** `timeUnixNano` as a decimal string; undefined when absent, zero, or not an unsigned integer. */
function timeOf(raw: unknown): string | undefined {
  const value = typeof raw === "number" && Number.isSafeInteger(raw) ? String(raw) : raw;
  if (typeof value !== "string" || !/^[0-9]+$/.test(value)) return undefined;
  const normalized = value.replace(/^0+/, ""); // "007" and "7" are the same instant
  return normalized !== "" && normalized.length <= 20 ? normalized : undefined;
}

/** Identity of a data point for dedupe; undefined without a timestamp (never deduplicated). */
function identity(
  kind: "metric" | "log",
  name: string,
  attrs: Map<string, string | number>,
  time: unknown,
): string | undefined {
  const at = timeOf(time);
  if (at === undefined) return undefined;
  const sorted = [...attrs].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return JSON.stringify([kind, text(attrs, "session.id"), name, sorted, at]);
}

/** The ledger entry for a data point; a refusal (too long, or ledger full) is reported as such. */
function entryFor(
  ledger: CostLedger,
  attrs: Map<string, string | number>,
  id: string | undefined,
  onFull: () => void,
): Entry | "skip" | "rejected" {
  const who = whoOf(attrs);
  if (who === undefined) return "skip";
  if (who === "too_long") return "rejected";
  // A re-delivered point is dropped before an entry is created, so it never evicts an agent.
  if (id !== undefined && !ledger.claim(id)) return "skip";
  const entry = ledger.entry(who.agentId, who.parent);
  if (entry === undefined) {
    onFull();
    return "rejected";
  }
  return entry;
}

type Ingest = (ledger: CostLedger, body: Json, onFull: () => void) => number;

const TOKEN_TYPES: ReadonlySet<string> = new Set(["input", "output", "cacheRead", "cacheCreation"]);

/** Returns the number of data points refused (an over-long key, or a full ledger). */
function ingestMetrics(ledger: CostLedger, body: Json, onFull: () => void): number {
  let rejected = 0;
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
          const value = number(point.asInt ?? point.asDouble);
          if (value === undefined) continue;
          const type = text(attrs, "type");
          if (isTokens && (type === undefined || !TOKEN_TYPES.has(type))) continue;
          const id = identity("metric", String(metric.name), attrs, point.timeUnixNano);
          const entry = entryFor(ledger, attrs, id, onFull);
          if (entry === "skip") continue;
          if (entry === "rejected") {
            rejected += 1;
            continue;
          }
          entry.metrics.seen = true;
          if (isTokens) entry.metrics.seenTokens = true;
          else entry.metrics.seenCost = true;
          if (isTokens) {
            const key = type as keyof CostTokens;
            entry.metrics.tokens[key] = add(entry.metrics.tokens[key], value);
          } else entry.metrics.costUsd = add(entry.metrics.costUsd, value);
          ledger.save(entry);
        }
      }
    }
  }
  return rejected;
}

function ingestLogs(ledger: CostLedger, body: Json, onFull: () => void): number {
  let rejected = 0;
  for (const resource of list(body.resourceLogs)) {
    for (const scope of list(resource.scopeLogs)) {
      for (const record of list(scope.logRecords)) {
        const attrs = attributes(record.attributes);
        if (attrs.get("event.name") !== "claude_code.api_request") continue;
        const id = identity("log", "claude_code.api_request", attrs, record.timeUnixNano);
        const entry = entryFor(ledger, attrs, id, onFull);
        if (entry === "skip") continue;
        if (entry === "rejected") {
          rejected += 1;
          continue;
        }
        const logs = entry.logs;
        logs.seen = true;
        const num = (key: string) => number(attrs.get(key)) ?? 0;
        logs.tokens.input = add(logs.tokens.input, num("input_tokens"));
        logs.tokens.output = add(logs.tokens.output, num("output_tokens"));
        logs.tokens.cacheRead = add(logs.tokens.cacheRead, num("cache_read_tokens"));
        logs.tokens.cacheCreation = add(logs.tokens.cacheCreation, num("cache_creation_tokens"));
        logs.costUsd = add(logs.costUsd, num("cost_usd"));
        ledger.save(entry);
      }
    }
  }
  return rejected;
}

export interface OtlpRouteOptions {
  ledger?: CostLedger;
  /** The engine's storage: totals persist across a restart. Without it the ledger is in memory. */
  storage?: Storage;
  /** Agents kept before the least recently updated is evicted; default MAX_LEDGER_AGENTS. */
  maxAgents?: number;
  /** For the one warning when the ledger is full (counts only, never an ID). */
  logger?: Logger;
}

/**
 * `POST /v1/otlp/v1/metrics` and `/logs` (scope `ingest`, the CLI token only; 5 MB; JSON only) and
 * `GET /v1/agents/:id/cost` (scope `read`). Registered on the app from `createApp`, so the Host,
 * Origin and credential middleware already ran. Errors never echo the input.
 */
export function registerOtlpRoutes(app: Hono<AppEnv>, options: OtlpRouteOptions = {}): CostLedger {
  const ledger = options.ledger ?? new CostLedger(options.storage?.otlpCost(), options.maxAgents);
  const receive = (path: string, ingest: Ingest, rejectedKey: string) =>
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
        const rejected = ledger.batch(() =>
          ingest(ledger, body, () => {
            if (ledger.noteFull()) {
              options.logger?.warn({ maxAgents: MAX_LEDGER_AGENTS }, "OTLP cost ledger is full");
            }
          }),
        );
        return c.json(
          rejected === 0 ? {} : { partialSuccess: { [rejectedKey]: String(rejected) } },
        );
      },
    );
  receive(OTLP_METRICS_PATH, ingestMetrics, "rejectedDataPoints");
  receive(OTLP_LOGS_PATH, ingestLogs, "rejectedLogRecords");
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
