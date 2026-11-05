import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  MAX_SEEN_DIGESTS,
  openStorage,
  SqliteOtlpCost,
  type Storage,
} from "../../../src/storage/index.ts";
import {
  costOf,
  fixture,
  makeOtlpApp,
  PARALLEL,
  readCost,
  sendLogs,
  sendMetrics,
} from "./helpers.ts";

// M5.29 review round (red): security review findings on PR #389.
//
// Seam needed (the implementer picks internals):
//
//   registerOtlpRoutes(app, { storage, maxAgents })   // maxAgents defaults to MAX_LEDGER_AGENTS
//
// `maxAgents` replaces the module constant as the ledger cap, so tests can use a cap of 3.
// Eviction needs a persisted recency per agent (a `last_seen` column from a new migration, or an
// edit of the unreleased V3; the column must order agents even when two writes share a
// millisecond, so use a monotonic counter or rowid-style sequence, not only a wall-clock time).
// Eviction and the insert of the new agent happen in the same export transaction.

let dir = "";
const opened: Storage[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taskville-otlp-review-"));
});
afterEach(() => {
  vi.restoreAllMocks();
  for (const storage of opened.splice(0)) {
    try {
      storage.close();
    } catch {
      // already closed by the test
    }
  }
  rmSync(dir, { recursive: true, force: true });
});

const dbPath = () => join(dir, "taskville.db");
async function boot(extra: object = {}) {
  const storage = openStorage(dbPath());
  opened.push(storage);
  const made = await makeOtlpApp({ storage, ...extra });
  return { ...made, storage };
}

/** Rows straight from the file, bypassing the engine. */
function rawRows<T = Record<string, unknown>>(sql: string): T[] {
  const raw = new DatabaseSync(dbPath());
  try {
    return raw.prepare(sql).all() as T[];
  } finally {
    raw.close();
  }
}

interface PointOptions {
  session: string;
  agent?: string;
  parent?: string;
  time?: string;
  cost?: number;
}
function costPoint({ session, agent, parent, time, cost = 1 }: PointOptions) {
  const attributes = [{ key: "session.id", value: { stringValue: session } }];
  if (agent !== undefined) attributes.push({ key: "agent_id", value: { stringValue: agent } });
  if (parent !== undefined) {
    attributes.push({ key: "parent_agent_id", value: { stringValue: parent } });
  }
  return {
    attributes,
    ...(time === undefined ? {} : { timeUnixNano: time }),
    asDouble: cost,
  };
}
const metricsOf = (...points: ReturnType<typeof costPoint>[]) => ({
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [{ name: "claude_code.cost.usage", sum: { dataPoints: points } }],
        },
      ],
    },
  ],
});

let clock = 1_800_000_000_000_000_000n;
const tick = (): string => {
  clock += 1_000_000_000n;
  return String(clock);
};
const send = (app: Parameters<typeof sendMetrics>[0], session: string) =>
  sendMetrics(app, metricsOf(costPoint({ session, time: tick() })));
const id = (session: string) => `claude-code:${session}`;

describe("a full ledger evicts the least recently updated agent (MEDIUM)", () => {
  it("accepts a new agent by evicting the least recently updated one", async () => {
    const { app } = await boot({ maxAgents: 3 });
    for (const s of ["s1", "s2", "s3"]) expect((await send(app, s)).status).toBe(200);
    // s1 is updated again, so s2 is now the least recently updated.
    await send(app, "s1");

    const res = await send(app, "s4");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await costOf(app, id("s2"))).status).toBe(404);
    expect((await readCost(app, id("s1"))).costUsd).toBeCloseTo(2, 6);
    expect((await readCost(app, id("s3"))).costUsd).toBeCloseTo(1, 6);
    expect((await readCost(app, id("s4"))).costUsd).toBeCloseTo(1, 6);
    // The table never holds more than the cap, so eviction happened in the store as well.
    expect(rawRows("SELECT agent_id FROM otlp_cost")).toHaveLength(3);
  });

  it("still accepts a new agent after a restart with a full table, evicting by persisted recency", async () => {
    const first = await boot({ maxAgents: 3 });
    for (const s of ["s1", "s2", "s3"]) await send(first.app, s);
    await send(first.app, "s1");
    await send(first.app, "s4"); // evicts s2; recency now s3 < s1 < s4
    first.storage.close();

    const second = await boot({ maxAgents: 3 });
    const res = await send(second.app, "s5");
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await costOf(second.app, id("s3"))).status).toBe(404); // the oldest after restart
    for (const s of ["s1", "s4", "s5"]) {
      expect((await costOf(second.app, id(s))).status).toBe(200);
    }
    expect(rawRows("SELECT agent_id FROM otlp_cost")).toHaveLength(3);
  });

  it("does not evict when an existing agent is updated at the cap", async () => {
    const { app } = await boot({ maxAgents: 3 });
    for (const s of ["s1", "s2", "s3"]) await send(app, s);
    await send(app, "s2");
    for (const s of ["s1", "s2", "s3"]) expect((await costOf(app, id(s))).status).toBe(200);
  });
});

describe("a replayed point never evicts a current agent (HIGH)", () => {
  // s1 reports a timestamped point, is evicted when s4 arrives, and the same export is then
  // delivered again. The replay is a duplicate and must be rejected before the ledger makes room.
  const point = (session: string, time: string) => metricsOf(costPoint({ session, time }));

  async function fill(app: Parameters<typeof sendMetrics>[0]) {
    const replayed = point("s1", tick());
    expect((await sendMetrics(app, replayed)).status).toBe(200);
    for (const s of ["s2", "s3"]) await send(app, s);
    await send(app, "s4"); // ledger full: evicts s1
    expect((await costOf(app, id("s1"))).status).toBe(404);
    return replayed;
  }

  it("keeps every current agent when an evicted agent's counted point is replayed", async () => {
    const { app } = await boot({ maxAgents: 3 });
    const replayed = await fill(app);

    const res = await sendMetrics(app, replayed);
    expect(res.status).toBe(200);
    for (const s of ["s2", "s3", "s4"]) {
      expect((await readCost(app, id(s))).costUsd).toBeCloseTo(1, 6);
    }
    expect((await costOf(app, id("s1"))).status).toBe(404);
    expect(
      rawRows<{ agent_id: string }>("SELECT agent_id FROM otlp_cost")
        .map((r) => r.agent_id)
        .sort(),
    ).toEqual([id("s2"), id("s3"), id("s4")]);
  });

  it("keeps every current agent across a restart after the replay", async () => {
    const first = await boot({ maxAgents: 3 });
    const replayed = await fill(first.app);
    await sendMetrics(first.app, replayed);
    first.storage.close();

    const second = await boot({ maxAgents: 3 });
    for (const s of ["s2", "s3", "s4"]) {
      expect((await readCost(second.app, id(s))).costUsd).toBeCloseTo(1, 6);
    }
    expect((await costOf(second.app, id("s1"))).status).toBe(404);
  });
});

describe("timeUnixNano is normalized (LOW-1)", () => {
  // Both spellings are within the 20 digit bound the identity accepts.
  const PLAIN = "1800000000000000";
  const PADDED = "00001800000000000000";

  it("counts a metric once when re-delivered with leading zeros", async () => {
    const { app } = await boot();
    await sendMetrics(app, metricsOf(costPoint({ session: "lz", time: PLAIN })));
    await sendMetrics(app, metricsOf(costPoint({ session: "lz", time: PADDED })));
    expect((await readCost(app, id("lz"))).costUsd).toBeCloseTo(1, 6);
  });

  it("counts a metric once when the padded form arrives first", async () => {
    const { app } = await boot();
    await sendMetrics(app, metricsOf(costPoint({ session: "lz2", time: PADDED })));
    await sendMetrics(app, metricsOf(costPoint({ session: "lz2", time: PLAIN })));
    expect((await readCost(app, id("lz2"))).costUsd).toBeCloseTo(1, 6);
  });

  it("counts a log record once when re-delivered with leading zeros", async () => {
    const { app } = await boot();
    const record = (time: string) => ({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  timeUnixNano: time,
                  attributes: [
                    {
                      key: "event.name",
                      value: { stringValue: "claude_code.api_request" },
                    },
                    { key: "session.id", value: { stringValue: "lzlog" } },
                    { key: "cost_usd", value: { doubleValue: 0.5 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    await sendLogs(app, record(PLAIN));
    await sendLogs(app, record(PADDED));
    expect((await readCost(app, id("lzlog"))).costUsd).toBeCloseTo(0.5, 6);
  });
});

describe("a failed store write leaves memory equal to the database (LOW-2)", () => {
  it("counts a retried export once after a write throws mid-export", async () => {
    const { app } = await boot();
    const original = SqliteOtlpCost.prototype.save;
    let calls = 0;
    vi.spyOn(SqliteOtlpCost.prototype, "save").mockImplementation(function (
      this: SqliteOtlpCost,
      row,
    ) {
      calls += 1;
      if (calls === 3) throw new Error("disk I/O error");
      return original.call(this, row);
    });

    const failed = await sendMetrics(app, fixture("metrics-parallel.json"));
    expect(failed.status).toBeGreaterThanOrEqual(500);
    // Nothing committed, so nothing is visible: memory was rebuilt from the database.
    expect((await costOf(app, PARALLEL.lead)).status).toBe(404);
    expect(rawRows("SELECT agent_id FROM otlp_cost")).toHaveLength(0);

    vi.restoreAllMocks();
    const retry = await sendMetrics(app, fixture("metrics-parallel.json"));
    expect(retry.status).toBe(200);
    expect((await readCost(app, PARALLEL.a)).tokens).toEqual({
      input: 400,
      output: 90,
      cacheRead: 2000,
      cacheCreation: 100,
    });
    expect((await readCost(app, PARALLEL.lead)).tokens.input).toBe(1000);
  });
});

describe("keys that are not well-formed Unicode are rejected (LOW-4)", () => {
  const LONE = "bad\ud800id";
  const cases: [string, PointOptions][] = [
    ["session.id", { session: LONE, time: "1800000000000001" }],
    ["agent_id", { session: "ok-session", agent: LONE, time: "1800000000000002" }],
    ["parent_agent_id", { session: "ok-session", parent: LONE, time: "1800000000000003" }],
  ];
  for (const [name, options] of cases) {
    it(`counts a lone surrogate in ${name} as rejected and stores nothing`, async () => {
      const { app } = await boot();
      const res = await sendMetrics(app, metricsOf(costPoint(options)));
      expect(res.status).toBe(200);
      expect(await res.json()).toEqual({
        partialSuccess: { rejectedDataPoints: "1" },
      });
      expect(rawRows("SELECT agent_id FROM otlp_cost")).toHaveLength(0);
    });
  }

  it("keeps a well-formed astral character (a valid surrogate pair)", async () => {
    const { app } = await boot();
    const res = await sendMetrics(
      app,
      metricsOf(costPoint({ session: "emoji-\u{1F600}", time: "1800000000000004" })),
    );
    expect(await res.json()).toEqual({});
    expect((await readCost(app, id("emoji-\u{1F600}"))).costUsd).toBeCloseTo(1, 6);
  });
});

describe("guards that hold today", () => {
  it("a V2 database migrates to the latest schema and keeps its data", async () => {
    const first = openStorage(dbPath());
    first.transaction((tx) => {
      tx.insertProject({
        id: "demo",
        name: "Demo",
        roots: ["/repo"],
        builtin: false,
        createdAt: "t",
      });
    });
    first.close();
    // Make it look like a V2 file: no telemetry tables, schema_migrations at 2.
    const raw = new DatabaseSync(dbPath());
    raw.exec(
      "DROP TABLE otlp_cost; DROP TABLE otlp_seen; DELETE FROM schema_migrations WHERE version > 2;",
    );
    raw.close();

    const storage = openStorage(dbPath());
    opened.push(storage);
    expect(storage.project("demo")).toMatchObject({
      id: "demo",
      roots: ["/repo"],
    });
    const { app } = await makeOtlpApp({ storage });
    await send(app, "after-migration");
    expect((await readCost(app, id("after-migration"))).costUsd).toBeCloseTo(1, 6);
  });

  it("digest pruning keeps the newest MAX_SEEN_DIGESTS and forgets the oldest", () => {
    const storage = openStorage(dbPath());
    opened.push(storage);
    const seen = storage.otlpCost();
    const digest = (n: number) => n.toString(16).padStart(64, "0");
    const extra = 5;
    storage.transaction(() => {
      for (let n = 1; n <= MAX_SEEN_DIGESTS + extra; n++) seen.claim(digest(n));
    });
    expect(seen.claim(digest(MAX_SEEN_DIGESTS + extra))).toBe(false); // newest still remembered
    expect(seen.claim(digest(extra + 1))).toBe(false); // oldest kept
    expect(seen.claim(digest(1))).toBe(true); // oldest forgotten
  }, 60_000);
});
