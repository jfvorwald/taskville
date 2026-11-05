// Reads the engine's persisted OpenTelemetry cost rows (`otlp_cost`) for the retro snapshot.

import { existsSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import type { AgentCostRecord } from "./types.ts";

type Row = Record<string, number | string | null>;

/**
 * Tokens and cost per agent from the engine database at `dbPath`, sorted by agent ID. As in the
 * engine's cost endpoint, each quantity is the metrics total when metrics reported it, else the
 * logged sum. An agent that reported nothing is skipped. A missing database gives [].
 */
export function readAgentCost(dbPath: string): AgentCostRecord[] {
  if (!existsSync(dbPath)) return [];
  const db = new DatabaseSync(dbPath, { readOnly: true });
  try {
    // Older schemas have no otlp_cost table; cost is optional, so that reads as nothing measured.
    const table = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?");
    if (table.get("otlp_cost") === undefined) return [];
    const rows = db.prepare("SELECT * FROM otlp_cost ORDER BY agent_id").all() as Row[];
    const records: AgentCostRecord[] = [];
    for (const row of rows) {
      if (row.m_seen !== 1 && row.l_seen !== 1) continue;
      const pick = (seenMetrics: boolean, metric: string, log: string) =>
        Number(seenMetrics ? row[metric] : row[log]);
      const tokens = row.m_seen_tokens === 1;
      records.push({
        agentId: String(row.agent_id),
        tokens: {
          input: pick(tokens, "m_input", "l_input"),
          output: pick(tokens, "m_output", "l_output"),
          cacheRead: pick(tokens, "m_cache_read", "l_cache_read"),
          cacheCreation: pick(tokens, "m_cache_creation", "l_cache_creation"),
        },
        costUsd: pick(row.m_seen_cost === 1, "m_cost_usd", "l_cost_usd"),
      });
    }
    return records;
  } finally {
    db.close();
  }
}
