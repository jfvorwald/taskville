import type { Database, Statement } from "./sqlite.ts";

/** One agent's persisted totals; the shape of the receiver's ledger entry, flattened. */
export interface CostTotalsRow {
  agentId: string;
  parentAgentId?: string;
  metrics: TotalsRow & { seenTokens: boolean; seenCost: boolean };
  logs: TotalsRow;
}

export interface TotalsRow {
  seen: boolean;
  input: number;
  output: number;
  cacheRead: number;
  cacheCreation: number;
  costUsd: number;
}

/** The data-point identities remembered; the oldest are forgotten past this many. */
export const MAX_SEEN_DIGESTS = 200_000;

const flag = (value: boolean): number => (value ? 1 : 0);

/**
 * Telemetry cost totals and the identities of counted data points (`otlp_cost`, `otlp_seen`).
 * Callers bound the agent count; the identities are pruned here, oldest first.
 */
export class SqliteOtlpCost {
  readonly #db: Database;
  readonly #saveRow: Statement;
  readonly #claimRow: Statement;
  readonly #pruneSeen: Statement;
  readonly #evictRow: Statement;

  constructor(db: Database) {
    this.#db = db;
    // `last_seen` is a monotonic sequence, so recency is exact even within one millisecond.
    this.#saveRow = db.prepare(
      `INSERT OR REPLACE INTO otlp_cost (agent_id, parent_agent_id, m_seen, m_seen_tokens,
         m_seen_cost, m_input, m_output, m_cache_read, m_cache_creation, m_cost_usd, l_seen,
         l_input, l_output, l_cache_read, l_cache_creation, l_cost_usd, last_seen)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?,
         (SELECT COALESCE(MAX(last_seen), 0) + 1 FROM otlp_cost))`,
    );
    this.#claimRow = db.prepare("INSERT OR IGNORE INTO otlp_seen (digest) VALUES (?)");
    this.#pruneSeen = db.prepare("DELETE FROM otlp_seen WHERE id <= ?");
    this.#evictRow = db.prepare("DELETE FROM otlp_cost WHERE agent_id = ?");
  }

  /** The `limit` most recently updated agents, least recently updated first. */
  load(limit: number): CostTotalsRow[] {
    return this.#db
      .prepare(
        "SELECT * FROM (SELECT * FROM otlp_cost ORDER BY last_seen DESC LIMIT ?) ORDER BY last_seen",
      )
      .all(limit)
      .map((row) => ({
        agentId: String(row.agent_id),
        ...(row.parent_agent_id === null ? {} : { parentAgentId: String(row.parent_agent_id) }),
        metrics: {
          seen: row.m_seen === 1,
          seenTokens: row.m_seen_tokens === 1,
          seenCost: row.m_seen_cost === 1,
          input: Number(row.m_input),
          output: Number(row.m_output),
          cacheRead: Number(row.m_cache_read),
          cacheCreation: Number(row.m_cache_creation),
          costUsd: Number(row.m_cost_usd),
        },
        logs: {
          seen: row.l_seen === 1,
          input: Number(row.l_input),
          output: Number(row.l_output),
          cacheRead: Number(row.l_cache_read),
          cacheCreation: Number(row.l_cache_creation),
          costUsd: Number(row.l_cost_usd),
        },
      }));
  }

  save(row: CostTotalsRow): void {
    const { metrics: m, logs: l } = row;
    this.#saveRow.run(
      row.agentId,
      row.parentAgentId ?? null,
      flag(m.seen),
      flag(m.seenTokens),
      flag(m.seenCost),
      m.input,
      m.output,
      m.cacheRead,
      m.cacheCreation,
      m.costUsd,
      flag(l.seen),
      l.input,
      l.output,
      l.cacheRead,
      l.cacheCreation,
      l.costUsd,
    );
  }

  /** Forgets an agent's totals (the ledger evicts its least recently updated agent when full). */
  evict(agentId: string): void {
    this.#evictRow.run(agentId);
  }

  /** True when `digest` (64 hex characters) was not seen before, and remembers it. */
  claim(digest: string): boolean {
    const result = this.#claimRow.run(digest);
    if (Number(result.changes) === 0) return false;
    this.#pruneSeen.run(Number(result.lastInsertRowid) - MAX_SEEN_DIGESTS);
    return true;
  }

  /** Runs `work` in one transaction (joins one already open). */
  transaction<T>(work: () => T): T {
    if (this.#db.isTransaction) return work();
    this.#db.exec("BEGIN IMMEDIATE");
    try {
      const result = work();
      this.#db.exec("COMMIT");
      return result;
    } catch (error) {
      if (this.#db.isTransaction) this.#db.exec("ROLLBACK");
      throw error;
    }
  }
}
