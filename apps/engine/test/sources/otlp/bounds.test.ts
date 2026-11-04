import pino from "pino";
import { describe, expect, it } from "vitest";
import { MAX_LEDGER_AGENTS } from "../../../src/sources/otlp/index.ts";
import { costOf, makeOtlpApp, readCost, sendLogs, sendMetrics } from "./helpers.ts";

// M5.12 round 2 (security review of PR #370): bounded ledger keys and sums.
//
// Contract pinned here:
//  - A session.id, agent_id or parent_agent_id longer than 256 characters makes the whole data
//    point (or log record) ignored: nothing is stored for it. Exactly 256 is accepted.
//  - Every data point or record the receiver refuses for these reasons (an over-long key, or a new
//    agent when the ledger already holds MAX_LEDGER_AGENTS) is counted, and the export's answer
//    is the OTLP-native partial success: 200 `{ partialSuccess: { rejectedDataPoints: "<n>" } }`
//    (int64 as a string, rejected log records use `rejectedLogRecords`). With nothing refused the
//    answer stays `{}`. Metrics the receiver does not map are still ignored, not counted.
//  - When the ledger is full the receiver logs exactly one warning for the ledger's lifetime
//    (`registerOtlpRoutes(app, { logger })`, pino), carrying counts only and no session or agent
//    ID. Agents already in the ledger keep accumulating.
//  - Token and cost sums are clamped at Number.MAX_SAFE_INTEGER: never Infinity, never null in
//    the JSON, whatever the number of exports or the size of one value.

const str = (key: string, stringValue: string) => ({ key, value: { stringValue } });
const costPoint = (attrs: Record<string, string>, asDouble: number) => ({
  attributes: Object.entries(attrs).map(([k, v]) => str(k, v)),
  asDouble,
});
const tokenPoint = (attrs: Record<string, string>, type: string, asInt: string) => ({
  attributes: [...Object.entries(attrs).map(([k, v]) => str(k, v)), str("type", type)],
  asInt,
});
const metrics = (name: string, dataPoints: unknown[]) => ({
  resourceMetrics: [{ scopeMetrics: [{ metrics: [{ name, sum: { dataPoints } }] }] }],
});
const COST = "claude_code.cost.usage";
const TOKENS = "claude_code.token.usage";

type Reply = { partialSuccess?: { rejectedDataPoints?: string; rejectedLogRecords?: string } };

describe("attribute values used as ledger keys", () => {
  it("accepts 256 characters and ignores a data point whose key is longer", async () => {
    const { app } = await makeOtlpApp();
    const ok = "s".repeat(256);
    const long = "s".repeat(257);
    const res = await sendMetrics(app, metrics(COST, [costPoint({ "session.id": ok }, 1)]));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    expect((await readCost(app, `claude-code:${ok}`)).costUsd).toBe(1);

    for (const attrs of [
      { "session.id": long },
      { "session.id": "short", agent_id: long },
      { "session.id": "short", agent_id: "a1", parent_agent_id: long },
    ]) {
      const bad = await sendMetrics(app, metrics(COST, [costPoint(attrs, 5)]));
      expect(bad.status).toBe(200);
      expect(((await bad.json()) as Reply).partialSuccess?.rejectedDataPoints).toBe("1");
    }
    expect((await costOf(app, `claude-code:${long}`)).status).toBe(404);
    expect((await costOf(app, "claude-code:short")).status).toBe(404);
    expect((await costOf(app, "claude-code:short:a1")).status).toBe(404);
  });

  it("applies the same bound to log records", async () => {
    const { app } = await makeOtlpApp();
    const record = (sessionId: string) => ({
      resourceLogs: [
        {
          scopeLogs: [
            {
              logRecords: [
                {
                  attributes: [
                    str("event.name", "claude_code.api_request"),
                    str("session.id", sessionId),
                    { key: "cost_usd", value: { doubleValue: 2 } },
                  ],
                },
              ],
            },
          ],
        },
      ],
    });
    const long = "l".repeat(257);
    const res = await sendLogs(app, record(long));
    expect(res.status).toBe(200);
    expect(((await res.json()) as Reply).partialSuccess?.rejectedLogRecords).toBe("1");
    expect((await costOf(app, `claude-code:${long}`)).status).toBe(404);
    expect((await sendLogs(app, record("l".repeat(256)))).status).toBe(200);
    expect((await readCost(app, `claude-code:${"l".repeat(256)}`)).costUsd).toBe(2);
  });
});

describe("a full ledger", () => {
  const warnings = (lines: string[]) =>
    lines.map((l) => JSON.parse(l) as { level: number }).filter((l) => l.level === 40);

  it("drops new agents visibly, warns once with counts only, and keeps updating known agents", async () => {
    const lines: string[] = [];
    const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(line) });
    const { app } = await makeOtlpApp({ logger });
    const fill = Array.from({ length: MAX_LEDGER_AGENTS }, (_, i) =>
      costPoint({ "session.id": `fill-${i}` }, 1),
    );
    const filled = await sendMetrics(app, metrics(COST, fill));
    expect(await filled.json()).toEqual({});
    expect(warnings(lines)).toHaveLength(0);

    const more = await sendMetrics(
      app,
      metrics(
        COST,
        Array.from({ length: 5 }, (_, i) => costPoint({ "session.id": `extra-${i}` }, 1)),
      ),
    );
    expect(more.status).toBe(200);
    expect(((await more.json()) as Reply).partialSuccess?.rejectedDataPoints).toBe("5");
    expect((await costOf(app, "claude-code:extra-0")).status).toBe(404);

    const again = await sendMetrics(
      app,
      metrics(COST, [costPoint({ "session.id": "extra-9" }, 1)]),
    );
    expect(((await again.json()) as Reply).partialSuccess?.rejectedDataPoints).toBe("1");

    const warned = warnings(lines);
    expect(warned).toHaveLength(1);
    const text = lines.join("\n");
    expect(text).not.toContain("extra-");
    expect(text).not.toContain("fill-");

    // A known agent keeps accumulating.
    const known = await sendMetrics(app, metrics(COST, [costPoint({ "session.id": "fill-0" }, 2)]));
    expect(await known.json()).toEqual({});
    expect((await readCost(app, "claude-code:fill-0")).costUsd).toBe(3);
  }, 60_000);
});

describe("sums are clamped at Number.MAX_SAFE_INTEGER", () => {
  const MAX = Number.MAX_SAFE_INTEGER;

  it("clamps token and cost sums from metrics, across exports and within one value", async () => {
    const { app } = await makeOtlpApp();
    const a = { "session.id": "clamp", agent_id: "m" };
    const body = {
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name: TOKENS,
                  sum: {
                    dataPoints: [
                      tokenPoint(a, "input", String(MAX)),
                      tokenPoint(a, "input", String(MAX)),
                      tokenPoint(a, "output", "99999999999999999999999"),
                    ],
                  },
                },
                { name: COST, sum: { dataPoints: [costPoint(a, 1e308), costPoint(a, 1e308)] } },
              ],
            },
          ],
        },
      ],
    };
    expect((await sendMetrics(app, body)).status).toBe(200);
    expect((await sendMetrics(app, body)).status).toBe(200);
    const res = await costOf(app, "claude-code:clamp:m");
    const text = await res.text();
    expect(text).not.toContain("null");
    const cost = JSON.parse(text) as Awaited<ReturnType<typeof readCost>>;
    expect(cost.tokens.input).toBe(MAX);
    expect(cost.tokens.output).toBe(MAX);
    expect(cost.costUsd).toBe(MAX);
  });

  it("clamps sums from api_request log records the same way", async () => {
    const { app } = await makeOtlpApp();
    const record = {
      attributes: [
        str("event.name", "claude_code.api_request"),
        str("session.id", "clamp-logs"),
        { key: "cost_usd", value: { doubleValue: 1e308 } },
        { key: "input_tokens", value: { intValue: String(MAX) } },
      ],
    };
    const body = { resourceLogs: [{ scopeLogs: [{ logRecords: [record, record] }] }] };
    expect((await sendLogs(app, body)).status).toBe(200);
    const res = await costOf(app, "claude-code:clamp-logs");
    const text = await res.text();
    expect(text).not.toContain("null");
    const cost = JSON.parse(text) as Awaited<ReturnType<typeof readCost>>;
    expect(cost.tokens.input).toBe(MAX);
    expect(cost.costUsd).toBe(MAX);
  });
});
