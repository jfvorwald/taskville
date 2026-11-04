import { describe, expect, it } from "vitest";
import { makeOtlpApp, readCost, sendLogs, sendMetrics } from "./helpers.ts";

// M5.12 round 3 (roborev 6884): tokens and cost are chosen independently. For each quantity, an
// agent reports the metric total when metrics reported that quantity for it, otherwise the sum of
// its api_request log records; the two are never added together (no double counting). So a
// token-only metric export does not hide the cost that api_request logs carry, and a cost-only
// metric export does not hide the logged tokens. Arrival order must not matter.

const SESSION = "indep-session";
const AGENT = `claude-code:${SESSION}`;
const str = (key: string, stringValue: string) => ({ key, value: { stringValue } });

const tokenMetric = (input: number) => ({
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name: "claude_code.token.usage",
              sum: {
                dataPoints: [
                  {
                    attributes: [str("session.id", SESSION), str("type", "input")],
                    asInt: String(input),
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
const costMetric = (usd: number) => ({
  resourceMetrics: [
    {
      scopeMetrics: [
        {
          metrics: [
            {
              name: "claude_code.cost.usage",
              sum: { dataPoints: [{ attributes: [str("session.id", SESSION)], asDouble: usd }] },
            },
          ],
        },
      ],
    },
  ],
});
const apiRequest = (usd: number, input: number) => ({
  resourceLogs: [
    {
      scopeLogs: [
        {
          logRecords: [
            {
              attributes: [
                str("event.name", "claude_code.api_request"),
                str("session.id", SESSION),
                { key: "cost_usd", value: { doubleValue: usd } },
                { key: "input_tokens", value: { intValue: String(input) } },
              ],
            },
          ],
        },
      ],
    },
  ],
});

type App = Awaited<ReturnType<typeof makeOtlpApp>>["app"];
type Step = (app: App) => Promise<Response>;
/** Runs the steps in the given order, then in reverse, each on a fresh app. */
async function bothOrders(steps: Step[], check: (app: App) => Promise<void>) {
  for (const ordered of [steps, [...steps].reverse()]) {
    const { app } = await makeOtlpApp();
    for (const step of ordered) expect((await step(app)).status).toBe(200);
    await check(app);
  }
}

describe("tokens and cost are chosen independently", () => {
  it("token metrics without a cost metric: tokens from metrics, cost from the api_request logs", async () => {
    await bothOrders(
      [(app) => sendMetrics(app, tokenMetric(100)), (app) => sendLogs(app, apiRequest(0.5, 999))],
      async (app) => {
        const cost = await readCost(app, AGENT);
        expect(cost.tokens.input).toBe(100);
        expect(cost.costUsd).toBeCloseTo(0.5, 6);
      },
    );
  });

  it("a cost metric with logs: cost from the metric only, tokens from the logs when no token metric exists", async () => {
    await bothOrders(
      [(app) => sendMetrics(app, costMetric(0.2)), (app) => sendLogs(app, apiRequest(0.5, 40))],
      async (app) => {
        const cost = await readCost(app, AGENT);
        expect(cost.costUsd).toBeCloseTo(0.2, 6);
        expect(cost.tokens.input).toBe(40);
      },
    );
  });

  it("token and cost metrics both present: metric figures only, nothing added from the logs", async () => {
    await bothOrders(
      [
        (app) => sendMetrics(app, tokenMetric(100)),
        (app) => sendMetrics(app, costMetric(0.2)),
        (app) => sendLogs(app, apiRequest(5, 999)),
      ],
      async (app) => {
        const cost = await readCost(app, AGENT);
        expect(cost.tokens.input).toBe(100);
        expect(cost.costUsd).toBeCloseTo(0.2, 6);
      },
    );
  });

  it("sums repeated api_request records for a quantity no metric reported", async () => {
    const { app } = await makeOtlpApp();
    await sendMetrics(app, tokenMetric(100));
    await sendLogs(app, apiRequest(0.25, 1));
    await sendLogs(app, apiRequest(0.25, 1));
    const cost = await readCost(app, AGENT);
    expect(cost.tokens.input).toBe(100);
    expect(cost.costUsd).toBeCloseTo(0.5, 6);
  });
});
