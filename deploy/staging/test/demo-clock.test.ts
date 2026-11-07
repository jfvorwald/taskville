// The demo's clock: timestamps are rebased once per isolate so the run ends at the isolate's
// first request time; sequence numbers and content do not change. A fresh module load stands for
// a fresh isolate. The clock under test is the system clock (`Date`), faked here.

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fetchEvents, makeStagingFrom, pair, withSession } from "./support.ts";

const T1 = Date.parse("2026-11-06T12:00:00Z");
const DAY = 24 * 60 * 60 * 1000;

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
});

/** A new isolate: modules reloaded at `loadAt`, first request made at `firstRequestAt`. */
async function isolate(loadAt: number, firstRequestAt = loadAt) {
  vi.resetModules();
  vi.setSystemTime(loadAt);
  const staging = makeStagingFrom(await import("../src/worker.ts"));
  vi.setSystemTime(firstRequestAt);
  const session = await pair(staging);
  const events = await fetchEvents(staging, session);
  return { staging, session, events };
}

const time = (event: Record<string, unknown>, field: string) => Date.parse(String(event[field]));
const normalized = (events: Record<string, unknown>[]) =>
  events.map((event) =>
    JSON.stringify(event).replace(/\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/g, "<time>"),
  );

describe("demo clock", () => {
  it("ends the run at the isolate's first request time", async () => {
    const { events } = await isolate(T1 - 60 * 60 * 1000, T1);
    const first = events[0];
    const last = events.at(-1);
    if (!first || !last) throw new Error("no events");
    const duration = time(last, "receivedAt") - time(first, "receivedAt");
    expect(duration).toBeGreaterThan(0);
    expect(time(last, "receivedAt")).toBeLessThanOrEqual(T1);
    expect(T1 - time(last, "receivedAt")).toBeLessThan(duration);
  });

  it("rebases once: later requests in the same isolate see the same timestamps", async () => {
    const { staging, session, events } = await isolate(T1);
    vi.setSystemTime(T1 + 10 * 60 * 1000);
    const again = await fetchEvents(staging, session);
    expect(again.map((e) => e.receivedAt)).toEqual(events.map((e) => e.receivedAt));
    const projects = (await (await staging.call("/v1/projects", withSession(session))).json()) as {
      projects: { id: string; lastEventAt: string }[];
    };
    expect(projects.projects.find((p) => p.id === "demo")?.lastEventAt).toBe(
      events.at(-1)?.receivedAt,
    );
  });

  it("a later isolate's run ends at its own first request, with the same sequence numbers", async () => {
    const one = await isolate(T1);
    const two = await isolate(T1 + 3 * DAY);
    const last = two.events.at(-1);
    if (!last) throw new Error("no events");
    expect(time(last, "receivedAt")).toBeLessThanOrEqual(T1 + 3 * DAY);
    expect(T1 + 3 * DAY - time(last, "receivedAt")).toBeLessThan(DAY);
    expect(two.events.map((e) => e.ingestSequence)).toEqual(
      one.events.map((e) => e.ingestSequence),
    );
    expect(normalized(two.events)).toEqual(normalized(one.events));
    // The whole run is shifted by the same amount: nothing else about its timing changed.
    for (const field of ["receivedAt", "occurredAt"]) {
      const shifts = new Set(
        two.events.map((e, i) => time(e, field) - time(one.events[i] ?? {}, field)),
      );
      expect([...shifts]).toEqual([3 * DAY]);
    }
  });

  it("is deterministic: two isolates at the same time agree on events and state hash", async () => {
    const hashOf = async (run: Awaited<ReturnType<typeof isolate>>) => {
      const response = await run.staging.call(
        "/v1/projects/demo/snapshot",
        withSession(run.session),
      );
      return ((await response.json()) as { stateHash: string; cursor: number }).stateHash;
    };
    const a = await isolate(T1);
    const b = await isolate(T1);
    expect(JSON.stringify(b.events)).toBe(JSON.stringify(a.events));
    expect(await hashOf(b)).toBe(await hashOf(a));
  });
});
