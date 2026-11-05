import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { LATEST_SCHEMA_VERSION, openStorage, type Storage } from "../../../src/storage/index.ts";
import {
  costOf,
  fixture,
  makeOtlpApp,
  NESTED,
  PARALLEL,
  readCost,
  sendLogs,
  sendMetrics,
} from "./helpers.ts";

// M5.29 (#369): tokens and cost persist in an additive SQLite table, so they survive an engine
// restart, and a re-delivered OTLP export is counted once.
//
// Seam pinned here (the implementer picks the internals):
//
//   registerOtlpRoutes(app, { storage })   // storage is the engine's `Storage` (openStorage)
//
// With a `storage`, every accepted data point is written to a new table added by a new migration
// (the existing tables and migrations are untouched), and a ledger built over the same database
// file after a restart answers `GET /v1/agents/:id/cost` with the same figures, before any new
// export arrives. Without `storage` the ledger stays in memory, as in M5.12.
//
// Dedupe: a metric data point is identified by session, metric name, attributes and
// `timeUnixNano`; a log record by session, attributes and `timeUnixNano`. A second delivery of the
// same identity is ignored, also across a restart, and the export still answers 200 `{}`. A point
// with a later `timeUnixNano` is a new data point and counts. A point or record that carries no
// `timeUnixNano` cannot be identified as a re-delivery and is never deduplicated (the M5.12 tests
// send such points repeatedly and expect sums).
//
// Temporality (pinned from M5.12): the receiver ignores `aggregationTemporality` and treats every
// data point as a delta, adding it to the agent's total. Cumulative points are NOT converted to
// deltas; distinct timestamps simply add. The fixtures are all delta (temporality 1). This pins
// the current ledger semantics, not a claim that cumulative export is supported.

let dir = "";
const opened: Storage[] = [];
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taskville-otlp-persist-"));
});
afterEach(() => {
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
const open = (): Storage => {
  const storage = openStorage(dbPath());
  opened.push(storage);
  return storage;
};

/** One engine run: storage plus the app with the OTLP routes over it. */
async function boot() {
  const storage = open();
  const made = await makeOtlpApp({ storage });
  return { ...made, storage };
}

/** Deep copy of an export with every `timeUnixNano` moved later by `seconds`. */
function later<T>(body: T, seconds: number): T {
  const shift = (value: unknown): unknown => {
    if (Array.isArray(value)) return value.map(shift);
    if (typeof value !== "object" || value === null) return value;
    return Object.fromEntries(
      Object.entries(value).map(([key, v]) => [
        key,
        key === "timeUnixNano" && typeof v === "string"
          ? String(BigInt(v) + BigInt(seconds) * 1_000_000_000n)
          : shift(v),
      ]),
    );
  };
  return shift(body) as T;
}

const A_ONCE = {
  tokens: { input: 400, output: 90, cacheRead: 2000, cacheCreation: 100 },
  costUsd: 0.12,
};

describe("tokens and cost survive an engine restart", () => {
  it("adds one additive migration for the cost rows", () => {
    // M5.29 adds a migration; V1 and V2 are not edited.
    expect(LATEST_SCHEMA_VERSION).toBeGreaterThanOrEqual(3);
  });

  it("answers the same figures from the same database after a restart", async () => {
    const first = await boot();
    await sendMetrics(first.app, fixture("metrics-parallel.json"));
    await sendMetrics(first.app, fixture("metrics-nested.json"));
    const before = {
      lead: await readCost(first.app, PARALLEL.lead),
      a: await readCost(first.app, PARALLEL.a),
      b: await readCost(first.app, PARALLEL.b),
      inner: await readCost(first.app, NESTED.inner),
    };
    first.storage.close();

    const second = await boot();
    expect(await readCost(second.app, PARALLEL.lead)).toEqual(before.lead);
    expect(await readCost(second.app, PARALLEL.a)).toEqual(before.a);
    expect(await readCost(second.app, PARALLEL.b)).toEqual(before.b);
    // The parent link survives too, and nothing is rolled up.
    expect(await readCost(second.app, NESTED.inner)).toEqual(before.inner);
    expect(before.inner.parentAgentId).toBe("ac5497782768787b9");
    expect((await costOf(second.app, NESTED.lead)).status).toBe(404);
  });

  it("keeps summing new data points on top of the persisted totals", async () => {
    const first = await boot();
    await sendMetrics(first.app, fixture("metrics-parallel.json"));
    first.storage.close();

    const second = await boot();
    await sendMetrics(second.app, later(fixture("metrics-parallel.json"), 60));
    const a = await readCost(second.app, PARALLEL.a);
    expect(a.tokens).toEqual({ input: 800, output: 180, cacheRead: 4000, cacheCreation: 200 });
    expect(a.costUsd).toBeCloseTo(0.24, 6);
  });

  it("persists api_request log totals for an agent that exports logs only", async () => {
    const first = await boot();
    await sendLogs(first.app, fixture("logs-api-requests.json"));
    const before = await readCost(
      first.app,
      "claude-code:5c2f7a10-3b6d-4e0a-9f1e-0a7d2c9b8e41:a7e3d1c9b5f20486a",
    );
    expect(before.costUsd).toBeGreaterThan(0);
    first.storage.close();

    const second = await boot();
    expect(
      await readCost(
        second.app,
        "claude-code:5c2f7a10-3b6d-4e0a-9f1e-0a7d2c9b8e41:a7e3d1c9b5f20486a",
      ),
    ).toEqual(before);
  });

  it("keeps choosing metrics over logs per quantity after a restart", async () => {
    const first = await boot();
    await sendMetrics(first.app, fixture("metrics-parallel.json"));
    first.storage.close();

    const second = await boot();
    // Subagent a is in the metrics and in the logs fixture; metrics win, so the logs add nothing.
    await sendLogs(second.app, fixture("logs-api-requests.json"));
    const a = await readCost(second.app, PARALLEL.a);
    expect(a.tokens).toEqual(A_ONCE.tokens);
    expect(a.costUsd).toBeCloseTo(A_ONCE.costUsd, 6);
  });

  it("starts empty on a new database and does not leak into another home", async () => {
    const first = await boot();
    await sendMetrics(first.app, fixture("metrics-parallel.json"));
    first.storage.close();

    const other = openStorage(join(dir, "other.db"));
    opened.push(other);
    const { app } = await makeOtlpApp({ storage: other });
    expect((await costOf(app, PARALLEL.a)).status).toBe(404);
  });
});

describe("a re-delivered export is counted once", () => {
  it("ignores a second identical metrics export", async () => {
    const { app } = await boot();
    const body = fixture("metrics-parallel.json");
    expect((await sendMetrics(app, body)).status).toBe(200);
    const again = await sendMetrics(app, body);
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({});
    const a = await readCost(app, PARALLEL.a);
    expect(a.tokens).toEqual(A_ONCE.tokens);
    expect(a.costUsd).toBeCloseTo(A_ONCE.costUsd, 6);
  });

  it("dedupes in memory too, without a storage", async () => {
    const { app } = await makeOtlpApp();
    await sendMetrics(app, fixture("metrics-parallel.json"));
    await sendMetrics(app, fixture("metrics-parallel.json"));
    expect((await readCost(app, PARALLEL.a)).tokens).toEqual(A_ONCE.tokens);
  });

  it("counts a data point with a later timestamp as new", async () => {
    const { app } = await boot();
    const body = fixture("metrics-parallel.json");
    await sendMetrics(app, body);
    await sendMetrics(app, later(body, 30));
    // The retried original after the newer one is still only counted once.
    await sendMetrics(app, body);
    const a = await readCost(app, PARALLEL.a);
    expect(a.tokens).toEqual({ input: 800, output: 180, cacheRead: 4000, cacheCreation: 200 });
    expect(a.costUsd).toBeCloseTo(0.24, 6);
  });

  it("tells data points apart by attributes at the same timestamp", async () => {
    const { app } = await boot();
    await sendMetrics(app, fixture("metrics-parallel.json"));
    // The fixture's four token types and one cost share one timestamp; none hid another.
    expect((await readCost(app, PARALLEL.lead)).tokens).toEqual({
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheCreation: 300,
    });
  });

  it("counts the same point once across a restart", async () => {
    const first = await boot();
    await sendMetrics(first.app, fixture("metrics-parallel.json"));
    first.storage.close();

    const second = await boot();
    const retry = await sendMetrics(second.app, fixture("metrics-parallel.json"));
    expect(retry.status).toBe(200);
    expect(await retry.json()).toEqual({});
    expect((await readCost(second.app, PARALLEL.a)).tokens).toEqual(A_ONCE.tokens);
  });

  it("ignores a re-delivered logs export, and a later record counts", async () => {
    const { app } = await boot();
    const agent = "claude-code:5c2f7a10-3b6d-4e0a-9f1e-0a7d2c9b8e41:a7e3d1c9b5f20486a";
    const body = fixture("logs-api-requests.json");
    await sendLogs(app, body);
    const once = await readCost(app, agent);
    await sendLogs(app, body);
    expect(await readCost(app, agent)).toEqual(once);

    await sendLogs(app, later(body, 5));
    const twice = await readCost(app, agent);
    expect(twice.costUsd).toBeCloseTo(once.costUsd * 2, 6);
    expect(twice.tokens.input).toBe(once.tokens.input * 2);
  });

  it("never dedupes points that carry no timestamp (M5.12 behavior)", async () => {
    const { app } = await boot();
    const point = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: "claude_code.cost.usage",
                  sum: {
                    dataPoints: [
                      {
                        attributes: [{ key: "session.id", value: { stringValue: "no-time" } }],
                        asDouble: 0.5,
                      },
                    ],
                  },
                },
              ],
            },
          ],
        },
      ],
    };
    await sendMetrics(app, point);
    await sendMetrics(app, point);
    expect((await readCost(app, "claude-code:no-time")).costUsd).toBeCloseTo(1, 6);
  });
});

describe("temporality follows the M5.12 ledger: every point is a delta", () => {
  const cumulative = (asInt: string, timeUnixNano: string) => ({
    resourceMetrics: [
      {
        scopeMetrics: [
          {
            metrics: [
              {
                name: "claude_code.token.usage",
                sum: {
                  aggregationTemporality: 2,
                  isMonotonic: true,
                  dataPoints: [
                    {
                      attributes: [
                        { key: "session.id", value: { stringValue: "cumulative" } },
                        { key: "type", value: { stringValue: "input" } },
                      ],
                      startTimeUnixNano: "1793707200000000000",
                      timeUnixNano,
                      asInt,
                    },
                  ],
                },
              },
            ],
          },
        ],
      },
    ],
  });

  it("adds a cumulative-flagged point at a later timestamp, like a delta (current semantics)", async () => {
    const { app } = await boot();
    await sendMetrics(app, cumulative("100", "1793707200000000000"));
    await sendMetrics(app, cumulative("250", "1793707260000000000"));
    expect((await readCost(app, "claude-code:cumulative")).tokens.input).toBe(350);
  });

  it("still counts a re-delivered cumulative-flagged point once", async () => {
    const { app } = await boot();
    await sendMetrics(app, cumulative("100", "1793707200000000000"));
    await sendMetrics(app, cumulative("100", "1793707200000000000"));
    expect((await readCost(app, "claude-code:cumulative")).tokens.input).toBe(100);
  });

  it("persists the delta totals across a restart", async () => {
    const first = await boot();
    await sendMetrics(first.app, cumulative("100", "1793707200000000000"));
    await sendMetrics(first.app, cumulative("250", "1793707260000000000"));
    first.storage.close();
    const second = await boot();
    expect((await readCost(second.app, "claude-code:cumulative")).tokens.input).toBe(350);
  });
});
