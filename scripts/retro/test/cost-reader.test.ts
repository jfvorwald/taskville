import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { openStorage } from "../../../apps/engine/src/storage/index.ts";
import type { AgentCostRecord } from "../src/types.ts";

// M7.16 (#393), M5.29 low: the retro collector reads the engine's persisted `otlp_cost` rows into
// `Snapshot.agentCost`. Seam pinned here: `readAgentCost(dbPath: string): AgentCostRecord[]` in
// scripts/retro/src/cost.ts opens the engine database read-only. Per agent the metrics totals win
// for tokens when metrics saw tokens and for cost when metrics saw cost; otherwise the log totals
// are used (the same rule as the engine's cost endpoint). Agents with neither are skipped. The
// result is sorted by agentId. A missing database file gives []. The collector (collect.ts) then
// passes the result as `agentCost` when it is non-empty.

// Loaded by path only when the file exists, so before the implementation the suite fails on the
// missing function, not on an import error (the M5.01 pattern).
const COST_MODULE = join(import.meta.dirname, "../src/cost.ts");
async function readAgentCost(path: string): Promise<AgentCostRecord[]> {
  if (!existsSync(COST_MODULE)) throw new Error("scripts/retro/src/cost.ts does not exist yet");
  const mod = (await import(/* @vite-ignore */ "../src/cost.ts")) as {
    readAgentCost?: (dbPath: string) => AgentCostRecord[];
  };
  if (mod.readAgentCost === undefined) throw new Error("cost.ts does not export readAgentCost");
  return mod.readAgentCost(path);
}

let dir = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taskville-retro-cost-"));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

interface Row {
  id: string;
  mSeen?: number;
  mTokens?: number;
  mCost?: number;
  m?: [number, number, number, number, number];
  lSeen?: number;
  l?: [number, number, number, number, number];
  seq: number;
}

function seed(rows: Row[]): string {
  const path = join(dir, "taskville.db");
  openStorage(path).close(); // creates the real schema
  const db = new DatabaseSync(path);
  const insert = db.prepare(
    `INSERT INTO otlp_cost (agent_id, parent_agent_id, m_seen, m_seen_tokens, m_seen_cost,
       m_input, m_output, m_cache_read, m_cache_creation, m_cost_usd,
       l_seen, l_input, l_output, l_cache_read, l_cache_creation, l_cost_usd, last_seen)
     VALUES (?, NULL, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  for (const r of rows) {
    const m = r.m ?? [0, 0, 0, 0, 0];
    const l = r.l ?? [0, 0, 0, 0, 0];
    insert.run(r.id, r.mSeen ?? 0, r.mTokens ?? 0, r.mCost ?? 0, ...m, r.lSeen ?? 0, ...l, r.seq);
  }
  db.close();
  return path;
}

describe("readAgentCost (M5.29 follow-up)", () => {
  it("reads metrics totals per agent, sorted by agent ID", async () => {
    const path = seed([
      { id: "claude-code:b", mSeen: 1, mTokens: 1, mCost: 1, m: [10, 20, 30, 40, 0.5], seq: 2 },
      { id: "claude-code:a", mSeen: 1, mTokens: 1, mCost: 1, m: [1, 2, 3, 4, 0.25], seq: 1 },
    ]);
    expect(await readAgentCost(path)).toEqual([
      {
        agentId: "claude-code:a",
        tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
        costUsd: 0.25,
      },
      {
        agentId: "claude-code:b",
        tokens: { input: 10, output: 20, cacheRead: 30, cacheCreation: 40 },
        costUsd: 0.5,
      },
    ]);
  });

  it("falls back to log totals for what metrics never reported", async () => {
    const path = seed([
      {
        id: "claude-code:c",
        mSeen: 1,
        mCost: 1, // metrics saw cost only
        m: [0, 0, 0, 0, 2],
        lSeen: 1,
        l: [7, 8, 9, 10, 99],
        seq: 1,
      },
      { id: "claude-code:d", lSeen: 1, l: [1, 1, 1, 1, 0.75], seq: 2 },
    ]);
    expect(await readAgentCost(path)).toEqual([
      {
        agentId: "claude-code:c",
        tokens: { input: 7, output: 8, cacheRead: 9, cacheCreation: 10 },
        costUsd: 2,
      },
      {
        agentId: "claude-code:d",
        tokens: { input: 1, output: 1, cacheRead: 1, cacheCreation: 1 },
        costUsd: 0.75,
      },
    ]);
  });

  it("skips an agent that reported nothing, and returns [] for a missing database", async () => {
    const path = seed([{ id: "claude-code:e", seq: 1 }]);
    expect(await readAgentCost(path)).toEqual([]);
    expect(await readAgentCost(join(dir, "absent.db"))).toEqual([]);
  });

  it("returns [] for an existing database that has no otlp_cost table", async () => {
    const path = join(dir, "old.db");
    const db = new DatabaseSync(path);
    db.exec("CREATE TABLE other (x INTEGER)");
    db.close();
    expect(await readAgentCost(path)).toEqual([]);
  });
});
