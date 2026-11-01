import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  addProject,
  bootInProcess,
  type Engine,
  getJson,
  ingest,
  input,
  useDayEngine,
  useDbPath,
} from "./helpers.ts";

// GET /v1/timelines/:id/events?from=&to=&limit=&cursor=  (M6.01).
//
// Pinned contract:
// - 200 { timelineId, events: StoredEnvelope[], nextCursor: string | null }. Events are the
//   stored envelopes, ascending by ingest sequence, exactly as `GET .../events` (SSE) would send.
// - `from` and `to` are positions in the same grammar as `state?at=` (a decimal sequence or a
//   zoned ISO timestamp) and both bounds are INCLUSIVE. A sequence bound means that sequence;
//   a timestamp `from` means the first event received at or after it and a timestamp `to`
//   means the last event received at or before it. Defaults: from 1, to the head when the
//   request is served. `from` 0 means 1. `to` past the head means the head. An empty range
//   (from past `to` or past the head) is 200 with no events and a null nextCursor.
// - `limit` is an integer from 1 to 1000, default 200. 0, 1001, negatives, fractions and
//   non-numbers are 400 bad_request. A page never holds more than `limit` events.
// - `nextCursor` is opaque. It is null on the last page; otherwise sending it back (with the
//   same from, to and limit) returns the next page with no gap and no duplicate. The cursor
//   supersedes `from`. Pages are stable: with an explicit `to`, events ingested between
//   requests never change what the pages return. A cursor the engine did not issue is 400.
// - Unknown project and unknown timeline ids behave as for `state` (404 unknown_project and
//   404 not_found); a bad `from`, `to` or `limit` is 400 bad_request.

const day = useDayEngine();
const dbPath = useDbPath();
let small: Engine | undefined;
afterEach(() => {
  small?.close();
  small = undefined;
});

interface PageBody {
  timelineId: string;
  events: StoredEnvelope[];
  nextCursor: string | null;
}

const seqs = (events: readonly StoredEnvelope[]) => events.map((e) => e.ingestSequence);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

describe("bounds", () => {
  it("returns both bounds, in order, as the stored envelopes", async () => {
    const { app, events } = day();
    const { status, body } = await getJson<PageBody>(
      app,
      "/v1/timelines/live:demo/events?from=10&to=14",
    );
    expect(status).toBe(200);
    expect(body.timelineId).toBe("live:demo");
    expect(seqs(body.events)).toEqual([10, 11, 12, 13, 14]);
    expect(body.events).toEqual(events.slice(9, 14));
    expect(body.nextCursor).toBeNull();
  });

  it("from equal to `to` is one event; from 0 means 1; `to` past the head means the head", async () => {
    const { app, events } = day();
    const head = events.length;
    const one = await getJson<PageBody>(app, "/v1/timelines/live:demo/events?from=77&to=77");
    expect(seqs(one.body.events)).toEqual([77]);
    const zero = await getJson<PageBody>(app, "/v1/timelines/live:demo/events?from=0&to=2");
    expect(seqs(zero.body.events)).toEqual([1, 2]);
    const tail = await getJson<PageBody>(
      app,
      `/v1/timelines/live:demo/events?from=${head - 2}&to=${head + 5000}`,
    );
    expect(seqs(tail.body.events)).toEqual([head - 2, head - 1, head]);
    expect(tail.body.nextCursor).toBeNull();
  });

  it("an empty range is 200 with no events", async () => {
    const { app, events } = day();
    for (const q of [
      "from=20&to=10",
      `from=${events.length + 1}`,
      `from=${events.length + 9999}&to=${events.length + 99999}`,
    ]) {
      const { status, body } = await getJson<PageBody>(app, `/v1/timelines/live:demo/events?${q}`);
      expect(status, q).toBe(200);
      expect(body.events, q).toEqual([]);
      expect(body.nextCursor, q).toBeNull();
    }
  });

  it("timestamp bounds are inclusive: from is the first event at or after, to the last at or before", async () => {
    const { app, events } = day();
    const a = events[100] as StoredEnvelope;
    const b = events[140] as StoredEnvelope;
    const fromMs = Date.parse(a.receivedAt);
    const toMs = Date.parse(b.receivedAt);
    const want = events
      .filter((e) => Date.parse(e.receivedAt) >= fromMs && Date.parse(e.receivedAt) <= toMs)
      .map((e) => e.ingestSequence);
    const q = `from=${encodeURIComponent(new Date(fromMs).toISOString())}&to=${encodeURIComponent(new Date(toMs).toISOString())}`;
    const { status, body } = await getJson<PageBody>(app, `/v1/timelines/live:demo/events?${q}`);
    expect(status).toBe(200);
    expect(seqs(body.events)).toEqual(want);
    expect(want.length).toBeGreaterThanOrEqual(41);
  });

  it("defaults to the whole log from the start", async () => {
    const { app } = day();
    const { body } = await getJson<PageBody>(app, "/v1/timelines/live:demo/events?limit=3");
    expect(seqs(body.events)).toEqual([1, 2, 3]);
    expect(body.nextCursor).not.toBeNull();
  });
});

describe("paging", () => {
  it("defaults to 200 events a page", async () => {
    const { app } = day();
    const { body } = await getJson<PageBody>(app, "/v1/timelines/live:demo/events");
    expect(body.events).toHaveLength(200);
    expect(seqs(body.events)).toEqual(range(1, 200));
    expect(typeof body.nextCursor).toBe("string");
  });

  it("walks the whole day with no gap and no duplicate, ending on a null cursor", async () => {
    const { app, events } = day();
    const collected: StoredEnvelope[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `from=1&limit=1000${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { status, body } = await getJson<PageBody>(
        app,
        `/v1/timelines/live:demo/events?${query}`,
      );
      expect(status).toBe(200);
      expect(body.events.length).toBeLessThanOrEqual(1000);
      collected.push(...body.events);
      cursor = body.nextCursor;
      pages += 1;
      expect(pages).toBeLessThan(100);
    } while (cursor !== null);
    expect(pages).toBe(Math.ceil(events.length / 1000));
    expect(seqs(collected)).toEqual(range(1, events.length));
    expect(collected).toEqual(events);
  });

  it("pages inside an explicit window and ends exactly at `to`", async () => {
    const { app } = day();
    const seen: number[] = [];
    let cursor: string | null = null;
    do {
      const query: string = `from=300&to=612&limit=100${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { body } = await getJson<PageBody>(app, `/v1/timelines/live:demo/events?${query}`);
      expect(body.events.length).toBeLessThanOrEqual(100);
      seen.push(...seqs(body.events));
      cursor = body.nextCursor;
    } while (cursor !== null);
    expect(seen).toEqual(range(300, 612));
  });

  it("a page that ends exactly at `to` has a null cursor", async () => {
    const { app } = day();
    const { body } = await getJson<PageBody>(
      app,
      "/v1/timelines/live:demo/events?from=1&to=10&limit=10",
    );
    expect(seqs(body.events)).toEqual(range(1, 10));
    expect(body.nextCursor).toBeNull();
  });

  it("rejects limits outside 1..1000", async () => {
    const { app } = day();
    for (const limit of ["0", "1001", "-5", "1.5", "abc", "", "1e2"]) {
      const { status, body } = await getJson<{ error: { code: string } }>(
        app,
        `/v1/timelines/live:demo/events?limit=${encodeURIComponent(limit)}`,
      );
      expect(status, `limit=${limit}`).toBe(400);
      expect(body.error.code).toBe("bad_request");
    }
    const edge = await getJson<PageBody>(app, "/v1/timelines/live:demo/events?limit=1000");
    expect(edge.status).toBe(200);
    expect(edge.body.events).toHaveLength(1000);
    const one = await getJson<PageBody>(app, "/v1/timelines/live:demo/events?limit=1");
    expect(one.body.events).toHaveLength(1);
  });

  it("rejects malformed from, to and cursor with 400 bad_request", async () => {
    const { app } = day();
    for (const q of [
      "from=abc",
      "from=-1",
      "from=1.5",
      "to=yesterday",
      "to=2026-01-01",
      "to=",
      "from=",
      "cursor=not-a-cursor",
      "cursor=",
      "cursor=%00%00",
    ]) {
      const { status, body } = await getJson<{ error: { code: string } }>(
        app,
        `/v1/timelines/live:demo/events?${q}`,
      );
      expect(status, q).toBe(400);
      expect(body.error.code, q).toBe("bad_request");
    }
  });

  it("answers 404 for an unknown project or timeline", async () => {
    const { app } = day();
    const unknown = await getJson<{ error: { code: string } }>(
      app,
      "/v1/timelines/live:ghost/events",
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("unknown_project");
    const other = await getJson<{ error: { code: string } }>(app, "/v1/timelines/nonsense/events");
    expect(other.status).toBe(404);
    expect(other.body.error.code).toBe("not_found");
  });
});

describe("paging while the log grows", () => {
  it("pages inside an explicit `to` do not change when events are ingested between requests", async () => {
    const booted = bootInProcess(dbPath());
    small = booted.engine;
    addProject(small.storage, "demo");
    await ingest(
      booted.app,
      Array.from({ length: 24 }, (_, i) => input(`a${i}`)),
    );
    const head = small.storage.head("demo") ?? 0;
    expect(head).toBe(25);

    const first = await getJson<PageBody>(
      booted.app,
      `/v1/timelines/live:demo/events?from=1&to=${head}&limit=10`,
    );
    expect(seqs(first.body.events)).toEqual(range(1, 10));
    const cursor1 = first.body.nextCursor;
    expect(cursor1).not.toBeNull();

    await ingest(
      booted.app,
      Array.from({ length: 7 }, (_, i) => input(`b${i}`)),
    );

    const second = await getJson<PageBody>(
      booted.app,
      `/v1/timelines/live:demo/events?from=1&to=${head}&limit=10&cursor=${encodeURIComponent(cursor1 ?? "")}`,
    );
    expect(seqs(second.body.events)).toEqual(range(11, 20));
    const third = await getJson<PageBody>(
      booted.app,
      `/v1/timelines/live:demo/events?from=1&to=${head}&limit=10&cursor=${encodeURIComponent(second.body.nextCursor ?? "")}`,
    );
    expect(seqs(third.body.events)).toEqual(range(21, 25));
    expect(third.body.nextCursor).toBeNull();
  });

  it("an explicit `to` past the head is pinned in the cursor: later pages do not shift as events arrive", async () => {
    const booted = bootInProcess(dbPath());
    small = booted.engine;
    addProject(small.storage, "demo");
    await ingest(
      booted.app,
      Array.from({ length: 24 }, (_, i) => input(`a${i}`)),
    );
    expect(small.storage.head("demo")).toBe(25);

    // `to` is far past the head (25), so it means "the head when first resolved", and that
    // resolution rides in the cursor. The same query is sent on every page.
    const query = "from=1&to=1000000&limit=10";
    const first = await getJson<PageBody>(booted.app, `/v1/timelines/live:demo/events?${query}`);
    expect(seqs(first.body.events)).toEqual(range(1, 10));

    await ingest(
      booted.app,
      Array.from({ length: 7 }, (_, i) => input(`b${i}`)),
    );

    const second = await getJson<PageBody>(
      booted.app,
      `/v1/timelines/live:demo/events?${query}&cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
    );
    expect(seqs(second.body.events)).toEqual(range(11, 20));
    const third = await getJson<PageBody>(
      booted.app,
      `/v1/timelines/live:demo/events?${query}&cursor=${encodeURIComponent(second.body.nextCursor ?? "")}`,
    );
    expect(seqs(third.body.events)).toEqual(range(21, 25));
    expect(third.body.nextCursor).toBeNull();
  });

  it("a timestamp `to` past the head is pinned in the cursor too", async () => {
    const booted = bootInProcess(dbPath());
    small = booted.engine;
    addProject(small.storage, "demo");
    await ingest(
      booted.app,
      Array.from({ length: 24 }, (_, i) => input(`a${i}`)),
    );
    const query = `from=1&to=${encodeURIComponent("2999-01-01T00:00:00Z")}&limit=10`;
    const first = await getJson<PageBody>(booted.app, `/v1/timelines/live:demo/events?${query}`);
    expect(seqs(first.body.events)).toEqual(range(1, 10));
    await ingest(
      booted.app,
      Array.from({ length: 7 }, (_, i) => input(`b${i}`)),
    );
    const second = await getJson<PageBody>(
      booted.app,
      `/v1/timelines/live:demo/events?${query}&cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
    );
    const third = await getJson<PageBody>(
      booted.app,
      `/v1/timelines/live:demo/events?${query}&cursor=${encodeURIComponent(second.body.nextCursor ?? "")}`,
    );
    expect(seqs(second.body.events)).toEqual(range(11, 20));
    expect(seqs(third.body.events)).toEqual(range(21, 25));
    expect(third.body.nextCursor).toBeNull();
  });

  it("years 0 to 99 in a zoned `to` are read as written: 0050 is before the first event", async () => {
    const { app } = day();
    for (const to of ["0050-01-01T00:00:00Z", "0000-02-29T00:00:00Z"]) {
      const { status, body } = await getJson<PageBody>(
        app,
        `/v1/timelines/live:demo/events?to=${encodeURIComponent(to)}`,
      );
      expect(status, to).toBe(200);
      expect(body.events, to).toEqual([]);
      expect(body.nextCursor, to).toBeNull();
    }
  });

  it("without `to`, a request sees the head at the time it is served", async () => {
    const booted = bootInProcess(dbPath());
    small = booted.engine;
    addProject(small.storage, "demo");
    const before = await getJson<PageBody>(booted.app, "/v1/timelines/live:demo/events");
    expect(seqs(before.body.events)).toEqual([1]);
    await ingest(booted.app, [input("e1"), input("e2")]);
    const after = await getJson<PageBody>(booted.app, "/v1/timelines/live:demo/events");
    expect(seqs(after.body.events)).toEqual([1, 2, 3]);
  });
});
