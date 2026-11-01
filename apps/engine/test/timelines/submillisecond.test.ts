import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parsePosition } from "../../src/timelines/position.ts";
import { seedLog } from "./day-log.ts";
import { bootInProcess, dayEvents, type Engine, getJson, useDbPath } from "./helpers.ts";

// Sub-millisecond fractions on a position (M6.01, roborev job 5976).
//
// Pinned contract (contracts/http-api.md, "Timelines"): a fraction finer than a millisecond is
// honored. A lower bound (`from`) rounds UP to the next whole millisecond, so it never includes
// an event received just before the bound; an upper bound (`at`, `to`) rounds DOWN. A fraction
// that is exact at the millisecond (`.123000000`) is not rounded at all.
//
// Log (offsets in ms from T, by sequence): 1:0  2:123  3:1000.

const T = Date.parse("2026-03-01T00:00:00.000Z");
const OFFSETS = [0, 123, 1000];
const events: StoredEnvelope[] = dayEvents()
  .slice(0, OFFSETS.length)
  .map((e, i) => ({ ...e, receivedAt: new Date(T + (OFFSETS[i] ?? 0)).toISOString() }));

const MS = Date.parse("2026-03-01T00:00:00.123Z");

describe("parsePosition with sub-millisecond fractions", () => {
  it.each([
    ["2026-03-01T00:00:00.123000000Z", 0],
    ["2026-03-01T00:00:00.123Z", 0],
    ["2026-03-01T00:00:00.1230Z", 0],
    ["2026-03-01T00:00:00.1230001Z", 1],
    ["2026-03-01T00:00:00.1239Z", 1],
    ["2026-03-01T00:00:00.123999999Z", 1],
  ])("%s: the whole millisecond below is kept, the one above is +%i", (raw, up) => {
    const at = parsePosition(raw);
    expect(at).toMatchObject({ kind: "time", ms: MS, msCeil: MS + up });
  });

  it("a fraction of .0005 is half a millisecond past the whole one", () => {
    const base = Date.parse("2026-03-01T00:00:00.000Z");
    expect(parsePosition("2026-03-01T00:00:00.0005Z")).toMatchObject({
      ms: base,
      msCeil: base + 1,
    });
  });
});

const dbPath = useDbPath();
let engine: Engine | undefined;
let app: ReturnType<typeof bootInProcess>["app"];
beforeEach(() => {
  const booted = bootInProcess(dbPath());
  engine = booted.engine;
  app = booted.app;
  seedLog(engine.storage, events);
});
afterEach(() => {
  engine?.close();
  engine = undefined;
});

interface PageBody {
  events: StoredEnvelope[];
}
interface StateBody {
  at: number;
}
const seqsFor = async (query: string) => {
  const { status, body } = await getJson<PageBody>(app, `/v1/timelines/live:demo/events?${query}`);
  expect(status, query).toBe(200);
  return body.events.map((e) => e.ingestSequence);
};
const ts = (fraction: string) => encodeURIComponent(`2026-03-01T00:00:00.${fraction}Z`);

describe("sub-millisecond bounds on the events route", () => {
  it("a `from` half a millisecond past an event excludes it", async () => {
    expect(await seqsFor(`from=${ts("0005")}`)).toEqual([2, 3]);
    expect(await seqsFor(`from=${ts("1230001")}`)).toEqual([3]);
    expect(await seqsFor(`from=${ts("1239")}`)).toEqual([3]);
  });

  it("a `from` exact at the millisecond includes the event, however many zeros follow", async () => {
    expect(await seqsFor(`from=${ts("000")}`)).toEqual([1, 2, 3]);
    expect(await seqsFor(`from=${ts("000000000")}`)).toEqual([1, 2, 3]);
    expect(await seqsFor(`from=${ts("123000000")}`)).toEqual([2, 3]);
  });

  it("a `to` with a fraction past an event's millisecond still includes it", async () => {
    expect(await seqsFor(`to=${ts("0005")}`)).toEqual([1]);
    expect(await seqsFor(`to=${ts("1239")}`)).toEqual([1, 2]);
    expect(await seqsFor(`to=${ts("123999999")}`)).toEqual([1, 2]);
  });

  it("a `to` just under an event's millisecond excludes it", async () => {
    expect(await seqsFor(`to=${ts("1229999")}`)).toEqual([1]);
  });

  it("a window between two sub-millisecond bounds holds only the events inside it", async () => {
    // from rounds up to .124 and to rounds down to .122: nothing is in between.
    expect(await seqsFor(`from=${ts("1235")}&to=${ts("1225")}`)).toEqual([]);
    expect(await seqsFor(`from=${ts("1225")}&to=${ts("1235")}`)).toEqual([2]);
  });
});

describe("sub-millisecond `at` on the state route", () => {
  it("rounds down: an event inside the millisecond is included, one after is not", async () => {
    const at = async (fraction: string) =>
      (await getJson<StateBody>(app, `/v1/timelines/live:demo/state?at=${ts(fraction)}`)).body.at;
    expect(await at("0005")).toBe(1);
    expect(await at("1239")).toBe(2);
    expect(await at("1229999")).toBe(1);
  });
});
