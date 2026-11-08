import { projectStateHash, replay } from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, describe, expect, it, vi } from "vitest";
import { openStorage, type Storage } from "../../src/storage/index.ts";
import { registerTimelineRoutes } from "../../src/timelines/index.ts";
import { bearer, CLI_TOKEN, makeApp } from "../http/helpers.ts";
import { envelope, HASH_A } from "../storage/helpers.ts";
import {
  addProject,
  BASE,
  bootInProcess,
  type Engine,
  getJson,
  ingest,
  input,
  useDbPath,
} from "./helpers.ts";

// Review-fix round for archive timelines (M8.07). Pinned contract on top of archives.test.ts:
// - `from` and `to` are inclusive at an exact event instant, and events sharing a millisecond are
//   all included by `from` and by `to`.
// - A forged cursor whose end is above the archive's eventCount is clamped, and the page that
//   reaches the end has `nextCursor: null`.
// - Archive reads never write live checkpoints and leave the live state and head unchanged.
// - State replay reads archive events in bounded chunks. `TimelineRouteOptions.archiveReplayChunk`
//   (a positive integer) sets the chunk size: `storage.archives().events(id, from, to)` is never
//   asked for more than that many positions at once, and the state still equals a full replay.

const dbPath = useDbPath();
let engine: Engine | undefined;
let loose: Storage | undefined;
afterEach(() => {
  engine?.close();
  engine = undefined;
  loose?.close();
  loose = undefined;
  vi.restoreAllMocks();
});

const ARCHIVE = "11111111-1111-4111-8111-111111111111";
const END = "2026-11-08T09:05:00.000Z";
const COUNTS = { read: 5, imported: 5, skipped: 0, malformed: 0 };

function events(occurred: readonly string[]): StoredEnvelope[] {
  return occurred.map((occurredAt, index) =>
    envelope("demo", index + 1, {
      sourceId: "git:test-repo",
      sourceEventId: `c-${index + 1}`,
      occurredAt,
      receivedAt: "2030-01-01T00:00:00.000Z",
      agentId: `agent-${index + 1}`,
      provenance: "imported",
      type: "agent.connected",
    }),
  );
}

function store(storage: Storage, written: StoredEnvelope[]): void {
  const archives = storage.archives();
  archives.create({
    id: ARCHIVE,
    projectId: "demo",
    kind: "git",
    label: "git: repo",
    root: "/tmp/taskville-archive-root",
    createdAt: "2026-11-08T09:00:00.000Z",
  });
  archives.complete(ARCHIVE, {
    events: written.map((event) => ({ envelope: event, contentHash: HASH_A })),
    counts: COUNTS,
    finishedAt: END,
  });
}

const URL_EVENTS = `/v1/timelines/archive:${ARCHIVE}/events`;
const URL_STATE = `/v1/timelines/archive:${ARCHIVE}/state`;
const enc = encodeURIComponent;

interface EventsBody {
  events: StoredEnvelope[];
  nextCursor: string | null;
}
const positions = (body: EventsBody) => body.events.map((e) => e.ingestSequence);

describe("from and to at exact instants and shared milliseconds", () => {
  it("includes an event at the exact instant of from, and of to", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    addProject(engine.storage, "demo");
    store(
      engine.storage,
      events([
        "2026-11-01T09:00:00.000Z",
        "2026-11-01T09:10:00.000Z",
        "2026-11-01T12:00:00.000+02:00", // 10:00Z
        "2026-11-01T10:30:00.000Z",
        "2026-11-01T11:00:00.000Z",
      ]),
    );
    const read = async (query: string) => {
      const res = await getJson<EventsBody>(booted.app, `${URL_EVENTS}?${query}`);
      expect(res.status, query).toBe(200);
      return positions(res.body);
    };
    expect(await read(`from=${enc("2026-11-01T10:30:00Z")}`)).toEqual([4, 5]);
    expect(await read(`from=${enc("2026-11-01T10:00:00Z")}`)).toEqual([3, 4, 5]);
    expect(await read(`from=${enc("2026-11-01T11:00:00Z")}`)).toEqual([5]);
    expect(await read(`from=${enc("2026-11-01T09:00:00Z")}`)).toEqual([1, 2, 3, 4, 5]);
    expect(await read(`to=${enc("2026-11-01T10:30:00Z")}`)).toEqual([1, 2, 3, 4]);
    expect(await read(`to=${enc("2026-11-01T09:00:00Z")}`)).toEqual([1]);
    expect(
      await read(`from=${enc("2026-11-01T10:30:00Z")}&to=${enc("2026-11-01T10:30:00Z")}`),
    ).toEqual([4]);
  });

  it("includes every event that shares a millisecond", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    addProject(engine.storage, "demo");
    store(
      engine.storage,
      events([
        "2026-11-01T09:00:00.000Z",
        "2026-11-01T09:10:00.123Z",
        "2026-11-01T09:10:00.123Z",
        "2026-11-01T09:10:00.123Z",
        "2026-11-01T09:20:00.000Z",
      ]),
    );
    const read = async (query: string) => {
      const res = await getJson<EventsBody>(booted.app, `${URL_EVENTS}?${query}`);
      expect(res.status, query).toBe(200);
      return positions(res.body);
    };
    const shared = enc("2026-11-01T09:10:00.123Z");
    expect(await read(`from=${shared}`)).toEqual([2, 3, 4, 5]);
    expect(await read(`to=${shared}`)).toEqual([1, 2, 3, 4]);
    expect(await read(`from=${shared}&to=${shared}`)).toEqual([2, 3, 4]);
    // A fraction finer than a millisecond: from rounds up, to rounds down.
    expect(await read(`from=${enc("2026-11-01T09:10:00.1230001Z")}`)).toEqual([5]);
    expect(await read(`to=${enc("2026-11-01T09:10:00.1239999Z")}`)).toEqual([1, 2, 3, 4]);
    const at = await getJson<{ at: number }>(booted.app, `${URL_STATE}?at=${shared}`);
    expect(at.body.at).toBe(4);
  });
});

describe("a forged cursor", () => {
  it("is clamped to the archive's eventCount and ends the walk", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    addProject(engine.storage, "demo");
    const written = events([
      "2026-11-01T09:00:00.000Z",
      "2026-11-01T09:10:00.000Z",
      "2026-11-01T10:00:00.000Z",
      "2026-11-01T10:30:00.000Z",
      "2026-11-01T11:00:00.000Z",
    ]);
    store(engine.storage, written);
    const forge = (next: number, until: number) =>
      `tl1.${Buffer.from(JSON.stringify([`archive:${ARCHIVE}`, next, until])).toString("base64url")}`;

    const high = await getJson<EventsBody>(
      booted.app,
      `${URL_EVENTS}?cursor=${enc(forge(2, 1_000_000))}`,
    );
    expect(high.status).toBe(200);
    expect(positions(high.body)).toEqual([2, 3, 4, 5]);
    expect(high.body.nextCursor).toBeNull();

    const paged = await getJson<EventsBody>(
      booted.app,
      `${URL_EVENTS}?limit=2&cursor=${enc(forge(4, 1_000_000))}`,
    );
    expect(positions(paged.body)).toEqual([4, 5]);
    expect(paged.body.nextCursor).toBeNull();

    const past = await getJson<EventsBody>(
      booted.app,
      `${URL_EVENTS}?cursor=${enc(forge(50, 1_000_000))}`,
    );
    expect(past.status).toBe(200);
    expect(past.body.events).toEqual([]);
    expect(past.body.nextCursor).toBeNull();
  });
});

describe("archive reads do not write", () => {
  it("writes no checkpoints and leaves the live state and head unchanged", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    addProject(engine.storage, "demo");
    await ingest(booted.app, [input("e1"), input("e2")]);
    // Longer than the checkpoint interval, so a reader that checkpointed archives would write.
    const occurred = Array.from({ length: 1100 }, (_, i) =>
      new Date(Date.parse("2026-11-01T00:00:00Z") + i * 1000).toISOString(),
    );
    store(engine.storage, events(occurred));

    const live = () =>
      getJson<Record<string, unknown>>(booted.app, "/v1/timelines/live:demo/state?at=2");
    const before = await live();
    const headBefore = engine.storage.head("demo");
    const liveCheckpoints = [...engine.storage.checkpoints().sequences("demo")];
    const projection = JSON.stringify(engine.storage.projection("demo"));

    for (const url of [
      `${URL_STATE}?at=1100`,
      `${URL_STATE}?at=550`,
      `${URL_STATE}?at=${enc("2026-11-01T00:10:00Z")}`,
      `${URL_EVENTS}?limit=1000`,
      "/v1/projects/demo/timelines",
    ]) {
      expect((await getJson(booted.app, url)).status, url).toBe(200);
    }

    expect(engine.storage.head("demo")).toBe(headBefore);
    expect(engine.storage.checkpoints().sequences("demo")).toEqual(liveCheckpoints);
    expect(engine.storage.checkpoints().sequences(ARCHIVE)).toEqual([]);
    expect(JSON.stringify(engine.storage.projection("demo"))).toBe(projection);
    const after = await live();
    expect(after.body.stateHash).toBe(before.body.stateHash);
    expect(after.body.state).toEqual(before.body.state);
  });
});

describe("chunked archive replay", () => {
  function bootChunked(chunk: number, count: number) {
    const { app } = makeApp();
    loose = openStorage(dbPath());
    addProject(loose, "demo");
    registerTimelineRoutes(app, { storage: loose, archiveReplayChunk: chunk } as Parameters<
      typeof registerTimelineRoutes
    >[1]);
    const written = events(
      Array.from({ length: count }, (_, i) =>
        new Date(Date.parse("2026-11-01T00:00:00Z") + i * 1000).toISOString(),
      ),
    );
    store(loose, written);
    return { app, storage: loose, written };
  }

  const getState = async (app: ReturnType<typeof makeApp>["app"], at: number) => {
    const res = await app.request(`${BASE}${URL_STATE}?at=${at}`, { headers: bearer(CLI_TOKEN) });
    return { status: res.status, body: (await res.json()) as Record<string, unknown> };
  };

  it("equals a full replay and never asks storage for more than the chunk at once", async () => {
    const { app, storage, written } = bootChunked(3, 11);
    const spy = vi.spyOn(storage.archives(), "events");
    for (const at of [11, 10, 6, 3, 1]) {
      spy.mockClear();
      const { status, body } = await getState(app, at);
      expect(status, `at ${at}`).toBe(200);
      const expected = replay("demo", written.slice(0, at));
      expect(body.at).toBe(at);
      expect(body.stateHash).toBe(projectStateHash(expected));
      expect(body.state).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(spy.mock.calls.length, `at ${at}`).toBe(Math.ceil(at / 3));
      for (const [id, from, to] of spy.mock.calls) {
        expect(id).toBe(ARCHIVE);
        expect(to - from + 1, `at ${at}: events(${from}, ${to})`).toBeLessThanOrEqual(3);
      }
    }
    const empty = await getState(app, 0);
    expect(empty.body.stateHash).toBe(projectStateHash(replay("demo", [])));
  });
});
