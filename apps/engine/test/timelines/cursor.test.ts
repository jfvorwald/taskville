import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  addProject,
  bootInProcess,
  type Engine,
  getJson,
  ingest,
  input,
  useDbPath,
} from "./helpers.ts";

// Cursor identity, shape and pinning for GET /v1/timelines/:id/events (M6.01 review round 3).
//
// Pinned contract:
// - A cursor is only good for the timeline that issued it. One issued for another timeline,
//   one that is not decodable, and one whose decoded content has the wrong shape are all 400
//   bad_request: bad base64, bad JSON, a tuple of the wrong length, a resume position below 1,
//   a pinned end that is not a positive integer.
// - The cursor always pins the last sequence the walk may return: the explicit `to` as first
//   resolved, or the head when `to` was omitted. Pages stay within the head at the first
//   request even when events are ingested between pages.
// - A cursor whose pinned end lies above the head (forged: the engine never issues one) is
//   clamped to the head: the page that reaches the head has a null nextCursor, never an extra
//   empty page.

const dbPath = useDbPath();
let small: Engine | undefined;
afterEach(() => {
  small?.close();
  small = undefined;
});

interface PageBody {
  events: StoredEnvelope[];
  nextCursor: string | null;
}

const seqs = (events: readonly StoredEnvelope[]) => events.map((e) => e.ingestSequence);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

/** A cursor as the engine writes them, with arbitrary content. */
const forge = (content: unknown): string =>
  `tl1.${Buffer.from(typeof content === "string" ? content : JSON.stringify(content)).toString("base64url")}`;
const unpack = (cursor: string): unknown[] =>
  JSON.parse(Buffer.from(cursor.slice("tl1.".length), "base64url").toString("utf8"));

const withCursor = (cursor: string, extra = "") =>
  `/v1/timelines/live:demo/events?cursor=${encodeURIComponent(cursor)}${extra}`;

/** demo with 25 events (head 25) and other with 13 (head 13). */
async function boot() {
  const booted = bootInProcess(dbPath());
  small = booted.engine;
  addProject(small.storage, "demo");
  addProject(small.storage, "other");
  await ingest(
    booted.app,
    Array.from({ length: 24 }, (_, i) => input(`a${i}`)),
  );
  await ingest(
    booted.app,
    Array.from({ length: 12 }, (_, i) => input(`o${i}`, { projectId: "other" })),
  );
  expect(small.storage.head("demo")).toBe(25);
  expect(small.storage.head("other")).toBe(13);
  return booted;
}

describe("cursor identity and shape", () => {
  it("control: a hand-made cursor of the engine's own shape is accepted", async () => {
    const { app } = await boot();
    const real = await getJson<PageBody>(app, "/v1/timelines/live:demo/events?limit=10");
    const [id, next, until] = unpack(real.body.nextCursor ?? "");
    expect([id, next]).toEqual(["live:demo", 11]);
    const { status, body } = await getJson<PageBody>(
      app,
      withCursor(forge(["live:demo", 11, until]), "&limit=3"),
    );
    expect(status).toBe(200);
    expect(seqs(body.events)).toEqual([11, 12, 13]);
  });

  it("refuses a cursor issued for another timeline", async () => {
    const { app } = await boot();
    const theirs = await getJson<PageBody>(app, "/v1/timelines/live:other/events?limit=5");
    expect(theirs.body.nextCursor).not.toBeNull();
    const real = await getJson<{ error: { code: string } }>(
      app,
      withCursor(theirs.body.nextCursor ?? ""),
    );
    expect(real.status).toBe(400);
    expect(real.body.error.code).toBe("bad_request");
    // The same position and end, relabelled by hand.
    const [, next, until] = unpack(theirs.body.nextCursor ?? "");
    for (const id of ["live:other", "live:", "demo", "live:Demo", ""]) {
      const { status } = await getJson(app, withCursor(forge([id, next, until])));
      expect(status, id).toBe(400);
    }
  });

  it("refuses a valid prefix with bad base64 or bad JSON", async () => {
    const { app } = await boot();
    const cursors = [
      "tl1.",
      "tl1.!!!!",
      "tl1.@@@@@@",
      "tl1.%00",
      forge("not json"),
      forge("["),
      forge('["live:demo", 3,'),
      forge(""),
      "tl1.bm90IGpzb24", // "not json" without padding
    ];
    for (const cursor of cursors) {
      const { status, body } = await getJson<{ error: { code: string } }>(app, withCursor(cursor));
      expect(status, cursor).toBe(400);
      expect(body.error.code, cursor).toBe("bad_request");
    }
  });

  it("refuses a decoded value that is not a three-element tuple", async () => {
    const { app } = await boot();
    const contents: unknown[] = [
      [],
      ["live:demo"],
      ["live:demo", 11],
      ["live:demo", 11, null, 5],
      ["live:demo", 11, null, null, null],
      { id: "live:demo", next: 11, until: null },
      "live:demo",
      11,
      null,
      true,
    ];
    for (const content of contents) {
      const { status } = await getJson(app, withCursor(forge(content)));
      expect(status, JSON.stringify(content)).toBe(400);
    }
  });

  it("refuses a resume position that is not a positive integer", async () => {
    const { app } = await boot();
    for (const next of [0, -1, 1.5, "11", null, true, 2 ** 60, [11]]) {
      const { status } = await getJson(app, withCursor(forge(["live:demo", next, null])));
      expect(status, JSON.stringify(next)).toBe(400);
    }
  });

  it("refuses a pinned end that is not an integer", async () => {
    const { app } = await boot();
    for (const until of [1.5, "25", true, -3, 2 ** 60, [25], {}, 11.0000001]) {
      const { status } = await getJson(app, withCursor(forge(["live:demo", 11, until])));
      expect(status, JSON.stringify(until)).toBe(400);
    }
  });
});

describe("the cursor pins the resolved end", () => {
  it("without `to`, pages stay within the head of the first request when events arrive between pages", async () => {
    const { app } = await boot();
    const first = await getJson<PageBody>(app, "/v1/timelines/live:demo/events?limit=10");
    expect(seqs(first.body.events)).toEqual(range(1, 10));
    expect(first.body.nextCursor).not.toBeNull();

    await ingest(
      app,
      Array.from({ length: 7 }, (_, i) => input(`b${i}`)),
    );
    expect(small?.storage.head("demo")).toBe(32);

    const second = await getJson<PageBody>(
      app,
      `/v1/timelines/live:demo/events?limit=10&cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
    );
    expect(seqs(second.body.events)).toEqual(range(11, 20));
    const third = await getJson<PageBody>(
      app,
      `/v1/timelines/live:demo/events?limit=10&cursor=${encodeURIComponent(second.body.nextCursor ?? "")}`,
    );
    expect(seqs(third.body.events)).toEqual(range(21, 25));
    expect(third.body.nextCursor).toBeNull();
  });

  it("with only `from`, the end is pinned the same way", async () => {
    const { app } = await boot();
    const first = await getJson<PageBody>(app, "/v1/timelines/live:demo/events?from=5&limit=10");
    expect(seqs(first.body.events)).toEqual(range(5, 14));
    await ingest(
      app,
      Array.from({ length: 7 }, (_, i) => input(`b${i}`)),
    );
    const second = await getJson<PageBody>(
      app,
      `/v1/timelines/live:demo/events?from=5&limit=20&cursor=${encodeURIComponent(first.body.nextCursor ?? "")}`,
    );
    expect(seqs(second.body.events)).toEqual(range(15, 25));
    expect(second.body.nextCursor).toBeNull();
  });

  it("a fresh request without a cursor still sees the new head", async () => {
    const { app } = await boot();
    await ingest(
      app,
      Array.from({ length: 7 }, (_, i) => input(`b${i}`)),
    );
    const { body } = await getJson<PageBody>(app, "/v1/timelines/live:demo/events?from=30");
    expect(seqs(body.events)).toEqual([30, 31, 32]);
  });
});

describe("a forged end above the head", () => {
  it("is clamped: the page that reaches the head has a null cursor, with no extra empty page", async () => {
    const { app } = await boot();
    const wide = await getJson<PageBody>(
      app,
      withCursor(forge(["live:demo", 21, 1_000_000]), "&limit=10"),
    );
    expect(wide.status).toBe(200);
    expect(seqs(wide.body.events)).toEqual(range(21, 25));
    expect(wide.body.nextCursor).toBeNull();

    // A page that ends exactly on the head.
    const exact = await getJson<PageBody>(
      app,
      withCursor(forge(["live:demo", 21, 26]), "&limit=5"),
    );
    expect(seqs(exact.body.events)).toEqual(range(21, 25));
    expect(exact.body.nextCursor).toBeNull();
  });

  it("walking from a forged cursor ends on the head without an empty page", async () => {
    const { app } = await boot();
    const pages: number[][] = [];
    let cursor: string | null = forge(["live:demo", 1, 9_999]);
    while (cursor !== null) {
      const res: { body: PageBody } = await getJson<PageBody>(app, withCursor(cursor, "&limit=10"));
      pages.push(seqs(res.body.events));
      cursor = res.body.nextCursor;
      expect(pages.length).toBeLessThan(10);
    }
    expect(pages).toEqual([range(1, 10), range(11, 20), range(21, 25)]);
  });
});
