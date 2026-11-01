import { projectStateHash, replay } from "@taskville/domain/reducer";
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

// Project isolation on timelines (M6.01 review round 3).
//
// Pinned contract: a timeline reads one project's log. With two projects ingesting interleaved
// (and sharing the engine clock), `live:demo` never returns an event, a sequence, a timestamp
// match or a piece of state that belongs to `live:other`, whatever the position.

const dbPath = useDbPath();
let small: Engine | undefined;
afterEach(() => {
  small?.close();
  small = undefined;
});

const seqs = (events: readonly StoredEnvelope[]) => events.map((e) => e.ingestSequence);
const range = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => from + i);

interface StateBody {
  at: number;
  stateHash: string;
  state: { projectId: string };
}

describe("two projects ingesting interleaved", () => {
  async function boot() {
    let ms = Date.parse("2026-11-01T00:00:00.000Z");
    const tick = () => {
      ms += 1000;
      return new Date(ms);
    };
    const booted = bootInProcess(dbPath(), { now: tick });
    small = booted.engine;
    addProject(small.storage, "demo");
    addProject(small.storage, "other");
    // demo gets 6 events and other gets 9, one request each, alternating; every ingest ticks the clock.
    for (let i = 0; i < 6; i += 1) {
      await ingest(booted.app, [input(`a${i}`, { agentId: "agent-demo" })]);
      await ingest(booted.app, [
        input(`o${i}`, { projectId: "other", agentId: "agent-other" }),
        ...(i < 3 ? [input(`p${i}`, { projectId: "other", agentId: "agent-other" })] : []),
      ]);
    }
    expect(small.storage.head("demo")).toBe(7);
    expect(small.storage.head("other")).toBe(10);
    return booted.app;
  }

  it("events are only the project's own, contiguous from 1", async () => {
    const app = await boot();
    const { body } = await getJson<{ events: StoredEnvelope[] }>(
      app,
      "/v1/timelines/live:demo/events",
    );
    expect(seqs(body.events)).toEqual(range(1, 7));
    expect(body.events.every((e) => e.projectId === "demo")).toBe(true);
    const other = await getJson<{ events: StoredEnvelope[] }>(
      app,
      "/v1/timelines/live:other/events",
    );
    expect(seqs(other.body.events)).toEqual(range(1, 10));
    expect(other.body.events.every((e) => e.projectId === "other")).toBe(true);
  });

  it("state is built from the project's own events at every position", async () => {
    const app = await boot();
    const storage = (small as Engine).storage;
    for (const [id, head] of [
      ["demo", 7],
      ["other", 10],
    ] as const) {
      const log = [...storage.events(id)];
      for (let at = 0; at <= head; at += 1) {
        const { body } = await getJson<StateBody>(app, `/v1/timelines/live:${id}/state?at=${at}`);
        expect(body.at).toBe(at);
        expect(body.state.projectId).toBe(id);
        expect(body.stateHash).toBe(projectStateHash(replay(id, log.slice(0, at))));
      }
    }
    // The other project's agent never leaks into this one's state, and vice versa.
    const mine = await getJson(app, "/v1/timelines/live:demo/state?at=7");
    expect(JSON.stringify(mine.body)).not.toContain("agent-other");
    const theirs = await getJson(app, "/v1/timelines/live:other/state?at=10");
    expect(JSON.stringify(theirs.body)).not.toContain("agent-demo");
  });

  it("a sequence past this project's head but within the other's is this project's head", async () => {
    const app = await boot();
    const { body } = await getJson<StateBody>(app, "/v1/timelines/live:demo/state?at=10");
    expect(body.at).toBe(7);
    const page = await getJson<{ events: StoredEnvelope[] }>(
      app,
      "/v1/timelines/live:demo/events?from=8&to=10",
    );
    expect(page.body.events).toEqual([]);
  });

  it("a timestamp resolves against this project's events only", async () => {
    const app = await boot();
    const storage = (small as Engine).storage;
    const mine = [...storage.events("demo")];
    const lastMine = mine.at(-1) as StoredEnvelope;
    const theirsLast = [...storage.events("other")].at(-1) as StoredEnvelope;
    // other's last event came after demo's last: that moment is demo's head, not a gap.
    expect(Date.parse(theirsLast.receivedAt)).toBeGreaterThan(Date.parse(lastMine.receivedAt));
    const at = await getJson<StateBody>(
      app,
      `/v1/timelines/live:demo/state?at=${encodeURIComponent(theirsLast.receivedAt)}`,
    );
    expect(at.body.at).toBe(7);
    // `from` the moment after demo's last event: nothing of demo's is left, though other has events.
    const from = new Date(Date.parse(lastMine.receivedAt) + 1).toISOString();
    const page = await getJson<{ events: StoredEnvelope[] }>(
      app,
      `/v1/timelines/live:demo/events?from=${encodeURIComponent(from)}`,
    );
    expect(page.body.events).toEqual([]);
    // `to` a moment that falls between two of demo's events but on one of other's.
    const second = mine[1] as StoredEnvelope;
    const to = await getJson<{ events: StoredEnvelope[] }>(
      app,
      `/v1/timelines/live:demo/events?to=${encodeURIComponent(second.receivedAt)}`,
    );
    expect(seqs(to.body.events)).toEqual([1, 2]);
  });

  it("the timeline list for a project describes its own log", async () => {
    const app = await boot();
    const { body } = await getJson<{
      timelines: Array<{ lastSequence: number; eventCount: number; projectId: string }>;
    }>(app, "/v1/projects/demo/timelines");
    expect(body.timelines).toHaveLength(1);
    expect(body.timelines[0]).toMatchObject({ projectId: "demo", lastSequence: 7, eventCount: 7 });
  });
});
