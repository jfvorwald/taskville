// Timeline reads: position parsing, paging and state, in the engine's behavior.

import { apiErrorSchema } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { makeStaging, pair, withSession } from "./support.ts";

const LIVE = "live:demo";

interface Page {
  timelineId: string;
  events: { ingestSequence: number; receivedAt: string }[];
  nextCursor: string | null;
}

async function setup() {
  const staging = makeStaging();
  const session = await pair(staging);
  const page = async (query: string) => {
    const response = await staging.call(
      `/v1/timelines/${LIVE}/events${query}`,
      withSession(session),
    );
    return { status: response.status, json: (await response.json()) as Page };
  };
  const head = (
    (await (await staging.call("/v1/projects", withSession(session))).json()) as {
      projects: { id: string; head: number }[];
    }
  ).projects.find((p) => p.id === "demo")?.head as number;
  return { staging, session, page, head };
}

const seqs = (page: Page) => page.events.map((e) => e.ingestSequence);

describe("timeline position from a timestamp", () => {
  it("a lower bound one nanosecond after an event excludes that event", async () => {
    const { page } = await setup();
    const { json: all } = await page("?limit=1000");
    const anchor = all.events[4];
    if (!anchor) throw new Error("too few events");
    const ms = Date.parse(anchor.receivedAt);
    const beyond = `${anchor.receivedAt.replace(/Z$/, "")}000001Z`;
    expect(beyond).toMatch(/\.\d{3}000001Z$/);

    const expected = all.events.find((e) => Date.parse(e.receivedAt) >= ms + 1);
    const { status, json } = await page(`?from=${encodeURIComponent(beyond)}&limit=1000`);
    expect(status).toBe(200);
    expect(json.events.map((e) => e.ingestSequence)).not.toContain(anchor.ingestSequence);
    expect(json.events[0]?.ingestSequence).toBe(expected?.ingestSequence);

    // The same instant at whole milliseconds still includes it.
    const exact = await page(`?from=${encodeURIComponent(anchor.receivedAt)}&limit=1000`);
    const first = all.events.find((e) => Date.parse(e.receivedAt) >= ms);
    expect(exact.json.events[0]?.ingestSequence).toBe(first?.ingestSequence);
  });

  it("an upper bound one nanosecond after an event still includes it (floor)", async () => {
    const { page } = await setup();
    const { json: all } = await page("?limit=1000");
    const anchor = all.events[4];
    if (!anchor) throw new Error("too few events");
    const ms = Date.parse(anchor.receivedAt);
    const beyond = `${anchor.receivedAt.replace(/Z$/, "")}000001Z`;
    const { json } = await page(`?to=${encodeURIComponent(beyond)}&limit=1000`);
    const lastIncluded = all.events.filter((e) => Date.parse(e.receivedAt) <= ms).at(-1);
    expect(json.events.at(-1)?.ingestSequence).toBe(lastIncluded?.ingestSequence);
  });
});

describe("timeline paging", () => {
  it("walks pages with nextCursor to the head, once each, ending with null", async () => {
    const { page, head } = await setup();
    const collected: number[] = [];
    let query = "?limit=100";
    for (let guard = 0; guard < 1000; guard++) {
      const { status, json } = await page(query);
      expect(status).toBe(200);
      expect(json.events.length).toBeLessThanOrEqual(100);
      collected.push(...seqs(json));
      if (json.nextCursor === null) break;
      query = `?limit=100&cursor=${encodeURIComponent(json.nextCursor)}`;
    }
    expect(collected).toEqual(Array.from({ length: head }, (_, i) => i + 1));
  });

  it("honors limit and returns a cursor only when more remain", async () => {
    const { page } = await setup();
    const { json } = await page("?limit=5");
    expect(seqs(json)).toEqual([1, 2, 3, 4, 5]);
    expect(typeof json.nextCursor).toBe("string");
    const next = await page(`?limit=5&cursor=${encodeURIComponent(json.nextCursor as string)}`);
    expect(seqs(next.json)).toEqual([6, 7, 8, 9, 10]);
  });

  it("bounds a page with from and to sequences, inclusive", async () => {
    const { page } = await setup();
    const { json } = await page("?from=3&to=7&limit=100");
    expect(seqs(json)).toEqual([3, 4, 5, 6, 7]);
    expect(json.nextCursor).toBeNull();
  });

  it("answers a to before from with an empty page", async () => {
    const { page } = await setup();
    const { status, json } = await page("?from=7&to=3");
    expect(status).toBe(200);
    expect(json.events).toEqual([]);
    expect(json.nextCursor).toBeNull();
  });

  it("refuses a cursor this timeline did not issue with 400", async () => {
    const { page } = await setup();
    for (const cursor of ["garbage", "tl1.garbage", "tl1.W10"]) {
      const { status, json } = await page(`?cursor=${cursor}`);
      expect(status, cursor).toBe(400);
      expect(apiErrorSchema.parse(json).error.code).toBe("bad_request");
    }
  });

  it("refuses a bad limit, from or to with 400", async () => {
    const { page } = await setup();
    for (const query of [
      "?limit=0",
      "?limit=1001",
      "?limit=abc",
      "?from=yesterday",
      "?to=2026-01-01",
    ]) {
      expect((await page(query)).status, query).toBe(400);
    }
  });
});

describe("timeline state", () => {
  it("at the head matches the live snapshot", async () => {
    const { staging, session, head } = await setup();
    const snapshot = (await (
      await staging.call("/v1/projects/demo/snapshot", withSession(session))
    ).json()) as { stateHash: string };
    const response = await staging.call(
      `/v1/timelines/${LIVE}/state?at=${head}`,
      withSession(session),
    );
    expect(response.status).toBe(200);
    const body = (await response.json()) as { stateHash: string; cursor: number };
    expect(body.cursor).toBe(head);
    expect(body.stateHash).toBe(snapshot.stateHash);
  });

  it("at 0 is the empty state, and a bad position is 400", async () => {
    const { staging, session } = await setup();
    const empty = await staging.call(`/v1/timelines/${LIVE}/state?at=0`, withSession(session));
    expect(((await empty.json()) as { cursor: number }).cursor).toBe(0);
    for (const at of ["", "-1", "1e3", "2026-01-01"]) {
      const response = await staging.call(
        `/v1/timelines/${LIVE}/state?at=${at}`,
        withSession(session),
      );
      expect(response.status, at).toBe(400);
    }
  });
});
