import { describe, expect, it } from "vitest";
import {
  costOf,
  fixture,
  LOGS_ONLY,
  makeOtlpApp,
  NESTED,
  PARALLEL,
  readCost,
  sendLogs,
  sendMetrics,
} from "./helpers.ts";

// M5.12 (#104): the optional OTLP/HTTP JSON receiver for Claude Code's OpenTelemetry export.
// Payloads are synthesized from the documentation (fixtures/otlp/README.md, decision #360).
//
// Contract pinned here (module apps/engine/src/sources/otlp/index.ts):
//   POST /v1/otlp/v1/metrics   OTLP ExportMetricsServiceRequest as JSON  -> 200 {}
//   POST /v1/otlp/v1/logs      OTLP ExportLogsServiceRequest as JSON     -> 200 {}
//   GET  /v1/agents/:id/cost   200 { agentId, parentAgentId?, tokens: { input, output, cacheRead,
//                              cacheCreation }, costUsd } | 404 { error: { code: "no_cost" } }
// Cost lives in a read endpoint, not in the event log or the reducer's ProjectState: telemetry is
// a counter, not a fact the world replays (no protocol or reducer change).
//
// Attribution: a data point or log record belongs to agent `claude-code:<session.id>` when it has
// no `agent_id` (the lead or a solo session) and to `claude-code:<session.id>:<agent_id>`
// otherwise, the adapters' own agent IDs. `parent_agent_id` is reported back as `parentAgentId`
// and never moves cost to the parent. Metrics are deltas and are summed across exports.
// Metrics win over logs: an agent with any token or cost metric reports metric totals only (logs
// carry the same spend as api_request events, and counting both would double it); an agent with
// logs only reports the sum of its api_request records.

describe("metrics: claude_code.token.usage and claude_code.cost.usage", () => {
  it("answers 200 {} and attributes tokens and cost to the lead and each subagent", async () => {
    const { app } = await makeOtlpApp();
    const res = await sendMetrics(app, fixture("metrics-parallel.json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});

    const lead = await readCost(app, PARALLEL.lead);
    expect(lead.agentId).toBe(PARALLEL.lead);
    expect(lead.tokens).toEqual({ input: 1000, output: 200, cacheRead: 5000, cacheCreation: 300 });
    expect(lead.costUsd).toBeCloseTo(0.3, 6);
    expect(lead.parentAgentId).toBeUndefined();

    const a = await readCost(app, PARALLEL.a);
    expect(a.tokens).toEqual({ input: 400, output: 90, cacheRead: 2000, cacheCreation: 100 });
    expect(a.costUsd).toBeCloseTo(0.12, 6);

    // int64 values may arrive as numbers as well as strings (b's tokens are numbers).
    const b = await readCost(app, PARALLEL.b);
    expect(b.tokens).toEqual({ input: 250, output: 60, cacheRead: 0, cacheCreation: 0 });
    expect(b.costUsd).toBeCloseTo(0.05, 6);
  });

  it("puts a subagent's cost on the subagent, not on the lead or its parent", async () => {
    const { app } = await makeOtlpApp();
    await sendMetrics(app, fixture("metrics-nested.json"));

    const inner = await readCost(app, NESTED.inner);
    expect(inner.costUsd).toBeCloseTo(0.02, 6);
    expect(inner.tokens).toEqual({ input: 120, output: 30, cacheRead: 400, cacheCreation: 20 });
    expect(inner.parentAgentId).toBe("ac5497782768787b9");

    // The outer subagent holds only its own spend; the inner one is not rolled up into it.
    const outer = await readCost(app, NESTED.outer);
    expect(outer.costUsd).toBeCloseTo(0.09, 6);
    expect(outer.tokens).toEqual({ input: 300, output: 80, cacheRead: 1000, cacheCreation: 50 });

    // Nothing was reported for the lead of that session, so it has no cost at all.
    expect((await costOf(app, NESTED.lead)).status).toBe(404);
  });

  it("sums delta exports of the same agent (data points at different timestamps)", async () => {
    // M5.29: an identical re-delivery is counted once (persistence.test.ts); a later export sums.
    const { app } = await makeOtlpApp();
    const body = fixture("metrics-parallel.json");
    await sendMetrics(app, body);
    await sendMetrics(
      app,
      JSON.parse(JSON.stringify(body).replaceAll("1793707200000000000", "1793707260000000000")),
    );
    const a = await readCost(app, PARALLEL.a);
    expect(a.tokens).toEqual({ input: 800, output: 180, cacheRead: 4000, cacheCreation: 200 });
    expect(a.costUsd).toBeCloseTo(0.24, 6);
  });

  it("answers 404 no_cost for an agent that no telemetry named", async () => {
    const { app } = await makeOtlpApp();
    await sendMetrics(app, fixture("metrics-parallel.json"));
    const res = await costOf(app, "claude-code:unknown-session:nobody");
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("no_cost");
  });
});

describe("unknown telemetry is ignored, not an error", () => {
  it("ignores metrics other than the two it maps (session count, lines of code)", async () => {
    const { app } = await makeOtlpApp();
    const res = await sendMetrics(app, fixture("metrics-parallel.json"));
    expect(res.status).toBe(200);
    // The fixture also holds claude_code.session.count and lines_of_code.count; they changed
    // nothing: the lead's tokens are the four token data points, not five.
    expect((await readCost(app, PARALLEL.lead)).tokens).toEqual({
      input: 1000,
      output: 200,
      cacheRead: 5000,
      cacheCreation: 300,
    });
  });

  it("accepts an export of only unknown metrics, an empty export, and unknown token types", async () => {
    const { app } = await makeOtlpApp();
    const only = (name: string, attributes: unknown[]) => ({
      resourceMetrics: [
        {
          scopeMetrics: [
            {
              metrics: [
                {
                  name,
                  sum: { dataPoints: [{ attributes, asInt: "7" }] },
                },
              ],
            },
          ],
        },
      ],
    });
    const session = { key: "session.id", value: { stringValue: "s-unknown" } };
    const bodies = [
      only("some.other.metric", [session]),
      only("claude_code.token.usage", [
        session,
        { key: "type", value: { stringValue: "mystery" } },
      ]),
      only("claude_code.token.usage", [{ key: "type", value: { stringValue: "input" } }]),
      {},
      { resourceMetrics: [] },
    ];
    for (const body of bodies) {
      const res = await sendMetrics(app, body);
      expect(res.status, JSON.stringify(body)).toBe(200);
    }
    expect((await costOf(app, "claude-code:s-unknown")).status).toBe(404);
  });

  it("accepts a log export with events it does not map (tool_result) and an empty one", async () => {
    const { app } = await makeOtlpApp();
    const res = await sendLogs(app, fixture("logs-api-requests.json"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({});
    // The tool_result record names the parallel lead; it must not create cost for it.
    expect((await costOf(app, PARALLEL.lead)).status).toBe(404);
    expect((await sendLogs(app, { resourceLogs: [] })).status).toBe(200);
    expect((await sendLogs(app, {})).status).toBe(200);
  });
});

describe("logs: claude_code.api_request events", () => {
  it("attributes an agent that exports logs only, summing its requests", async () => {
    const { app } = await makeOtlpApp();
    const res = await sendLogs(app, fixture("logs-api-requests.json"));
    expect(res.status).toBe(200);
    const agent = await readCost(app, LOGS_ONLY);
    expect(agent.tokens).toEqual({ input: 150, output: 30, cacheRead: 500, cacheCreation: 10 });
    expect(agent.costUsd).toBeCloseTo(0.1, 6);
    expect(agent.parentAgentId).toBe("ab12cd34ef567890a");
  });

  it("does not double count an agent that is in both metrics and logs, whichever came first", async () => {
    for (const metricsFirst of [true, false]) {
      const { app } = await makeOtlpApp();
      const steps = metricsFirst
        ? [
            () => sendMetrics(app, fixture("metrics-parallel.json")),
            () => sendLogs(app, fixture("logs-api-requests.json")),
          ]
        : [
            () => sendLogs(app, fixture("logs-api-requests.json")),
            () => sendMetrics(app, fixture("metrics-parallel.json")),
          ];
      for (const step of steps) expect((await step()).status).toBe(200);
      const a = await readCost(app, PARALLEL.a);
      expect(a.tokens, `metricsFirst=${metricsFirst}`).toEqual({
        input: 400,
        output: 90,
        cacheRead: 2000,
        cacheCreation: 100,
      });
      expect(a.costUsd).toBeCloseTo(0.12, 6);
    }
  });
});
