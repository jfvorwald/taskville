import { projectStateHash, REDUCER_VERSION, replay } from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_TOKEN, bearer, CLI_TOKEN, sessionHeaders } from "../http/helpers.ts";
import { envelope, HASH_A } from "../storage/helpers.ts";
import {
  addProject,
  bootInProcess,
  type Engine,
  get,
  getJson,
  ingest,
  input,
  useDbPath,
} from "./helpers.ts";

// Archive timelines in the timeline routes (M8.07; docs/superpowers/specs/2026-11-08-imports-design.md,
// "Archive timelines").
//
// Pinned contract:
// - GET /v1/projects/:id/timelines lists the live recording first, then the project's `done`
//   archives, newest first, each { id: "archive:<archiveId>", kind: "archive", archiveKind, label,
//   projectId, firstSequence: 1, lastSequence: eventCount, firstAt, lastAt, eventCount }.
//   Running, failed and cancelled archives and other projects' archives are not listed.
// - GET /v1/timelines/archive:<id>/state?at= : positions are archive positions (1..n); a timestamp
//   resolves to the greatest position whose occurredAt instant is at or before it (an offset
//   timestamp compares by instant); past the end is eventCount; 0 or before the first is the empty
//   state at 0. state and stateHash equal a full replay of archive events 1..at. attention is [].
// - GET /v1/timelines/archive:<id>/events : limit and cursor page over archive positions; from and
//   to are positions or timestamps on occurredAt. A cursor is bound to its timeline: a live cursor
//   on an archive (and the reverse) is 400 bad_request.
// - 404 not_found for an unknown archive, a not-done archive and a malformed archive id.
// - Same credentials as the live routes: bridge token 403, CLI token and paired session allowed.

const dbPath = useDbPath();
let engine: Engine | undefined;
afterEach(() => {
  engine?.close();
  engine = undefined;
});

const DONE = "11111111-1111-4111-8111-111111111111";
const DONE_NEWER = "22222222-2222-4222-8222-222222222222";
const RUNNING = "33333333-3333-4333-8333-333333333333";
const FAILED = "44444444-4444-4444-8444-444444444444";
const CANCELLED = "55555555-5555-4555-8555-555555555555";
const OTHER_PROJECT = "66666666-6666-4666-8666-666666666666";
const UNKNOWN = "77777777-7777-4777-8777-777777777777";
const END = "2026-11-08T09:05:00.000Z";
const COUNTS = { read: 5, imported: 5, skipped: 0, malformed: 0 };

// Event 3 is written with an offset: 12:00+02:00 is 10:00Z.
const OCCURRED = [
  "2026-11-01T09:00:00.000Z",
  "2026-11-01T09:10:00.000Z",
  "2026-11-01T12:00:00.000+02:00",
  "2026-11-01T10:30:00.000Z",
  "2026-11-01T11:00:00.000Z",
];

function archiveEvents(projectId: string, occurred = OCCURRED): StoredEnvelope[] {
  return occurred.map((occurredAt, index) =>
    envelope(projectId, index + 1, {
      sourceId: "git:test-repo",
      sourceEventId: `c-${index + 1}`,
      occurredAt,
      // Not the archive's clock: a reader that used receivedAt would resolve differently.
      receivedAt: "2030-01-01T00:00:00.000Z",
      agentId: `agent-${index + 1}`,
      provenance: "imported",
      type: "agent.connected",
    }),
  );
}

function boot() {
  const booted = bootInProcess(dbPath());
  engine = booted.engine;
  addProject(engine.storage, "demo");
  return booted;
}

function makeArchive(
  e: Engine,
  id: string,
  options: {
    projectId?: string;
    kind?: "git" | "transcripts";
    label?: string;
    createdAt?: string;
    finish?: "done" | "running" | "failed" | "cancelled";
    events?: StoredEnvelope[];
  } = {},
): StoredEnvelope[] {
  const projectId = options.projectId ?? "demo";
  const events = options.events ?? archiveEvents(projectId);
  const archives = e.storage.archives();
  archives.create({
    id,
    projectId,
    kind: options.kind ?? "git",
    label: options.label ?? "git: repo",
    root: "/tmp/taskville-archive-root",
    createdAt: options.createdAt ?? "2026-11-08T09:00:00.000Z",
  });
  const finish = options.finish ?? "done";
  if (finish === "done") {
    archives.complete(id, {
      events: events.map((event) => ({ envelope: event, contentHash: HASH_A })),
      counts: COUNTS,
      finishedAt: END,
    });
  } else if (finish === "failed") {
    archives.fail(id, {
      error: { code: "boom", message: "boom" },
      counts: COUNTS,
      finishedAt: END,
    });
  } else if (finish === "cancelled") {
    archives.cancel(id, { counts: COUNTS, finishedAt: END });
  }
  return events;
}

interface ListBody {
  projectId: string;
  timelines: Array<Record<string, unknown>>;
}
interface StateBody {
  timelineId: string;
  at: number;
  cursor: number;
  reducerVersion: number;
  stateHash: string;
  state: unknown;
  attention: unknown[];
}
interface EventsBody {
  timelineId: string;
  events: StoredEnvelope[];
  nextCursor: string | null;
}

const stateUrl = (id: string, at: string | number) =>
  `/v1/timelines/archive:${id}/state?at=${encodeURIComponent(String(at))}`;
const eventsUrl = (id: string, query = "") => `/v1/timelines/archive:${id}/events${query}`;

describe("GET /v1/projects/:id/timelines with archives", () => {
  it("lists the live recording first, then done archives newest first, with the archive fields", async () => {
    const { app } = boot();
    const e = engine as Engine;
    makeArchive(e, DONE, { createdAt: "2026-11-08T09:00:00.000Z", label: "git: older" });
    makeArchive(e, DONE_NEWER, {
      createdAt: "2026-11-08T09:30:00.000Z",
      kind: "transcripts",
      label: "transcripts: newer",
      events: archiveEvents("demo", OCCURRED.slice(0, 3)),
    });

    const { status, body } = await getJson<ListBody>(app, "/v1/projects/demo/timelines");
    expect(status).toBe(200);
    expect(body.timelines.map((t) => t.id)).toEqual([
      "live:demo",
      `archive:${DONE_NEWER}`,
      `archive:${DONE}`,
    ]);
    expect(body.timelines[0]).toMatchObject({ kind: "live" });
    expect(body.timelines[1]).toEqual({
      id: `archive:${DONE_NEWER}`,
      kind: "archive",
      archiveKind: "transcripts",
      label: "transcripts: newer",
      projectId: "demo",
      firstSequence: 1,
      lastSequence: 3,
      firstAt: OCCURRED[0],
      lastAt: OCCURRED[2],
      eventCount: 3,
    });
    expect(body.timelines[2]).toEqual({
      id: `archive:${DONE}`,
      kind: "archive",
      archiveKind: "git",
      label: "git: older",
      projectId: "demo",
      firstSequence: 1,
      lastSequence: 5,
      firstAt: OCCURRED[0],
      lastAt: OCCURRED[4],
      eventCount: 5,
    });
  });

  it("does not list running, failed or cancelled archives, nor another project's", async () => {
    const { app } = boot();
    const e = engine as Engine;
    addProject(e.storage, "other");
    makeArchive(e, DONE);
    makeArchive(e, FAILED, { finish: "failed", createdAt: "2026-11-08T09:10:00.000Z" });
    makeArchive(e, CANCELLED, { finish: "cancelled", createdAt: "2026-11-08T09:20:00.000Z" });
    makeArchive(e, OTHER_PROJECT, { projectId: "other", createdAt: "2026-11-08T09:25:00.000Z" });
    makeArchive(e, RUNNING, { finish: "running", createdAt: "2026-11-08T09:40:00.000Z" });

    const { body } = await getJson<ListBody>(app, "/v1/projects/demo/timelines");
    expect(body.timelines.map((t) => t.id)).toEqual(["live:demo", `archive:${DONE}`]);
    const other = await getJson<ListBody>(app, "/v1/projects/other/timelines");
    expect(other.body.timelines.map((t) => t.id)).toEqual([
      "live:other",
      `archive:${OTHER_PROJECT}`,
    ]);
  });
});

describe("GET /v1/timelines/archive:<id>/state", () => {
  it("equals a full replay of archive events 1..at, hash included, with empty attention", async () => {
    const { app } = boot();
    const events = makeArchive(engine as Engine, DONE);
    for (const at of [1, 2, 3, 4, 5]) {
      const { status, body } = await getJson<StateBody>(app, stateUrl(DONE, at));
      expect(status, `at ${at}`).toBe(200);
      const expected = replay("demo", events.slice(0, at));
      expect(body.timelineId).toBe(`archive:${DONE}`);
      expect(body.at).toBe(at);
      expect(body.cursor).toBe(at);
      expect(body.reducerVersion).toBe(REDUCER_VERSION);
      expect(body.state).toEqual(JSON.parse(JSON.stringify(expected)));
      expect(body.stateHash).toBe(projectStateHash(expected));
      expect(body.attention).toEqual([]);
    }
  });

  it("resolves a timestamp to the greatest position occurred at or before it", async () => {
    const { app } = boot();
    const events = makeArchive(engine as Engine, DONE);
    const cases: Array<[string, number]> = [
      ["2026-11-01T09:00:00Z", 1],
      ["2026-11-01T09:09:59.999Z", 1],
      ["2026-11-01T11:30:00+02:00", 2], // 09:30Z
      ["2026-11-01T10:00:00Z", 3], // event 3 is 12:00+02:00, the same instant
      ["2026-11-01T12:00:00+02:00", 3],
      ["2026-11-01T10:29:59Z", 3],
      ["2026-11-01T10:30:00Z", 4],
      ["2026-11-01T11:00:00Z", 5],
      ["2030-01-01T00:00:00Z", 5], // past the end, and past every receivedAt
    ];
    for (const [at, position] of cases) {
      const { status, body } = await getJson<StateBody>(app, stateUrl(DONE, at));
      expect(status, at).toBe(200);
      expect(body.at, at).toBe(position);
      expect(body.stateHash, at).toBe(projectStateHash(replay("demo", events.slice(0, position))));
    }
  });

  it("resolves 0, a time before the first event and a position past the end", async () => {
    const { app } = boot();
    makeArchive(engine as Engine, DONE);
    const empty = replay("demo", []);
    for (const at of ["0", "2026-11-01T08:59:59Z"]) {
      const { status, body } = await getJson<StateBody>(app, stateUrl(DONE, at));
      expect(status, at).toBe(200);
      expect(body.at).toBe(0);
      expect(body.stateHash).toBe(projectStateHash(empty));
      expect(body.attention).toEqual([]);
    }
    const past = await getJson<StateBody>(app, stateUrl(DONE, 99));
    expect(past.body.at).toBe(5);
  });

  it("refuses a missing or malformed at with 400 bad_request", async () => {
    const { app } = boot();
    makeArchive(engine as Engine, DONE);
    for (const path of [
      `/v1/timelines/archive:${DONE}/state`,
      stateUrl(DONE, "1e3"),
      stateUrl(DONE, "2026-11-01"),
    ]) {
      const { status, body } = await getJson<{ error: { code: string } }>(app, path);
      expect(status, path).toBe(400);
      expect(body.error.code).toBe("bad_request");
    }
  });
});

describe("GET /v1/timelines/archive:<id>/events", () => {
  it("pages over archive positions with limit and cursor, no gap and no duplicate", async () => {
    const { app } = boot();
    const events = makeArchive(engine as Engine, DONE);
    const seen: number[] = [];
    let cursor: string | null = null;
    let pages = 0;
    do {
      const query: string = `?limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const { status, body } = await getJson<EventsBody>(app, eventsUrl(DONE, query));
      expect(status).toBe(200);
      expect(body.timelineId).toBe(`archive:${DONE}`);
      expect(body.events.length).toBeLessThanOrEqual(2);
      seen.push(...body.events.map((event) => event.ingestSequence));
      cursor = body.nextCursor;
      pages += 1;
    } while (cursor && pages < 10);
    expect(seen).toEqual([1, 2, 3, 4, 5]);
    expect(pages).toBe(3);
    const all = await getJson<EventsBody>(app, eventsUrl(DONE));
    expect(all.body.events).toEqual(events);
    expect(all.body.nextCursor).toBeNull();
  });

  it("takes from and to as positions or timestamps on occurredAt", async () => {
    const { app } = boot();
    makeArchive(engine as Engine, DONE);
    const positions = async (query: string) => {
      const { status, body } = await getJson<EventsBody>(app, eventsUrl(DONE, query));
      expect(status, query).toBe(200);
      return body.events.map((event) => event.ingestSequence);
    };
    expect(await positions("?from=2&to=4")).toEqual([2, 3, 4]);
    expect(await positions("?from=0&to=99")).toEqual([1, 2, 3, 4, 5]);
    expect(await positions(`?from=${encodeURIComponent("2026-11-01T09:05:00Z")}`)).toEqual([
      2, 3, 4, 5,
    ]);
    expect(await positions(`?to=${encodeURIComponent("2026-11-01T10:00:00Z")}`)).toEqual([1, 2, 3]);
    expect(
      await positions(
        `?from=${encodeURIComponent("2026-11-01T11:30:00+02:00")}&to=${encodeURIComponent("2026-11-01T10:30:00Z")}`,
      ),
    ).toEqual([3, 4]);
    expect(await positions(`?from=${encodeURIComponent("2026-11-01T12:00:00Z")}`)).toEqual([]);
  });

  it("refuses a bad limit and a malformed cursor with 400 bad_request", async () => {
    const { app } = boot();
    makeArchive(engine as Engine, DONE);
    for (const query of ["?limit=0", "?limit=1001", "?cursor=nope"]) {
      const { status, body } = await getJson<{ error: { code: string } }>(
        app,
        eventsUrl(DONE, query),
      );
      expect(status, query).toBe(400);
      expect(body.error.code).toBe("bad_request");
    }
  });

  it("does not let a cursor cross timelines, live to archive or archive to live", async () => {
    const { app } = boot();
    makeArchive(engine as Engine, DONE);
    makeArchive(engine as Engine, DONE_NEWER, { createdAt: "2026-11-08T09:30:00.000Z" });
    await ingest(app, [input("e1"), input("e2"), input("e3")]);

    const live = await getJson<EventsBody>(app, "/v1/timelines/live:demo/events?limit=1");
    expect(live.body.nextCursor).not.toBeNull();
    const archive = await getJson<EventsBody>(app, eventsUrl(DONE, "?limit=1"));
    expect(archive.status).toBe(200);
    expect(archive.body.nextCursor).not.toBeNull();

    const liveOnArchive = await getJson<{ error: { code: string } }>(
      app,
      eventsUrl(DONE, `?limit=1&cursor=${encodeURIComponent(live.body.nextCursor ?? "")}`),
    );
    expect(liveOnArchive.status).toBe(400);
    expect(liveOnArchive.body.error.code).toBe("bad_request");

    const archiveOnLive = await getJson<{ error: { code: string } }>(
      app,
      `/v1/timelines/live:demo/events?limit=1&cursor=${encodeURIComponent(archive.body.nextCursor ?? "")}`,
    );
    expect(archiveOnLive.status).toBe(400);
    expect(archiveOnLive.body.error.code).toBe("bad_request");

    const otherArchive = await getJson<{ error: { code: string } }>(
      app,
      eventsUrl(DONE_NEWER, `?limit=1&cursor=${encodeURIComponent(archive.body.nextCursor ?? "")}`),
    );
    expect(otherArchive.status).toBe(400);
    expect(otherArchive.body.error.code).toBe("bad_request");
  });
});

describe("archive timeline lookup and credentials", () => {
  it("is 404 not_found for an unknown, a not-done and a malformed archive id", async () => {
    const { app } = boot();
    const e = engine as Engine;
    makeArchive(e, RUNNING, { finish: "running" });
    makeArchive(e, FAILED, { finish: "failed" });
    makeArchive(e, CANCELLED, { finish: "cancelled" });
    for (const id of [
      UNKNOWN,
      RUNNING,
      FAILED,
      CANCELLED,
      "",
      "not-a-uuid",
      "../live:demo",
      DONE.toUpperCase(),
    ]) {
      for (const path of [
        `/v1/timelines/archive:${id}/state?at=1`,
        `/v1/timelines/archive:${id}/events`,
      ]) {
        const { status, body } = await getJson<{ error: { code: string } }>(app, path);
        expect(status, path).toBe(404);
        expect(body.error.code, path).toBe("not_found");
      }
    }
  });

  it("applies the live credential rules", async () => {
    const booted = boot();
    makeArchive(engine as Engine, DONE);
    const session = booted.pairing.exchange(booted.pairing.issueCode()) ?? "";
    for (const path of [stateUrl(DONE, 1), eventsUrl(DONE, "?from=1&to=2")]) {
      expect((await get(booted.app, path, bearer(CLI_TOKEN))).status, `cli ${path}`).toBe(200);
      expect((await get(booted.app, path, sessionHeaders(session))).status, `session ${path}`).toBe(
        200,
      );
      const bridge = await get(booted.app, path, bearer(BRIDGE_TOKEN));
      expect(bridge.status, `bridge ${path}`).toBe(403);
      expect(await bridge.json()).toEqual({
        error: { code: "credential_not_allowed", message: expect.any(String) },
      });
    }
  });
});
