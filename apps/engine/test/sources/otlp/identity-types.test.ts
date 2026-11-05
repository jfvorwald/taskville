import { describe, expect, it } from "vitest";
import { makeOtlpApp, readCost, sendMetrics } from "./helpers.ts";

// M7.16 (#393), M5.29 low: a data point's dedupe identity comes from the raw attribute list with
// type tags, so two points that differ only in an attribute the cost reader ignores (a bool, an
// array, a kvlist, bytes, a negative number) are different points, and both count. Today those
// attributes are dropped before hashing, so the second point is taken for a re-delivery.

const TIME = "1800000000000000000";
const SESSION = "identity-types";

type Attr = { key: string; value: Record<string, unknown> };

const point = (extra: Attr[]) => ({
  attributes: [{ key: "session.id", value: { stringValue: SESSION } }, ...extra],
  timeUnixNano: TIME,
  asDouble: 1,
});
const body = (...points: ReturnType<typeof point>[]) => ({
  resourceMetrics: [
    {
      scopeMetrics: [
        { metrics: [{ name: "claude_code.cost.usage", sum: { dataPoints: points } }] },
      ],
    },
  ],
});

const PAIRS: Array<[string, Attr, Attr]> = [
  ["bool true and false", att("flag", { boolValue: true }), att("flag", { boolValue: false })],
  [
    "different arrays",
    att("list", { arrayValue: { values: [{ stringValue: "a" }] } }),
    att("list", { arrayValue: { values: [{ stringValue: "b" }] } }),
  ],
  [
    "different kvlists",
    att("map", { kvlistValue: { values: [{ key: "k", value: { stringValue: "1" } }] } }),
    att("map", { kvlistValue: { values: [{ key: "k", value: { stringValue: "2" } }] } }),
  ],
  ["different bytes", att("blob", { bytesValue: "AAEC" }), att("blob", { bytesValue: "AwQF" })],
  ["different negative ints", att("delta", { intValue: "-1" }), att("delta", { intValue: "-2" })],
];

function att(key: string, value: Record<string, unknown>): Attr {
  return { key, value };
}

describe("dedupe identity keeps every attribute, typed (M5.29 low)", () => {
  it.each(PAIRS)("counts both points when they differ by %s", async (_name, a, b) => {
    const { app } = await makeOtlpApp();
    await sendMetrics(app, body(point([a])));
    await sendMetrics(app, body(point([b])));
    expect((await readCost(app, `claude-code:${SESSION}`)).costUsd).toBeCloseTo(2, 6);
  });

  it("still counts an identical re-delivery once", async () => {
    const { app } = await makeOtlpApp();
    const same = att("flag", { boolValue: true });
    await sendMetrics(app, body(point([same])));
    await sendMetrics(app, body(point([same])));
    expect((await readCost(app, `claude-code:${SESSION}`)).costUsd).toBeCloseTo(1, 6);
  });
});
