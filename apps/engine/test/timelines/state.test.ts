import {
  type ProjectState,
  projectStateHash,
  REDUCER_VERSION,
  replay,
} from "@taskville/domain/reducer";
import { attention } from "@taskville/domain/selectors";
import type { StoredEnvelope } from "@taskville/protocol";
import { afterEach, describe, expect, it } from "vitest";
import {
  addProject,
  bootInProcess,
  type Engine,
  get,
  getJson,
  ingest,
  input,
  useDayEngine,
  useDbPath,
} from "./helpers.ts";

// GET /v1/timelines/:id/state?at=  (M6.01, checkpoint equivalence: constitution VI).
//
// Pinned contract (the implementer documents it in contracts/http-api.md):
// - Timeline id of a project's live recording is `live:<projectId>`.
// - `at` is a position on the timeline, either
//     * a decimal ingest sequence ("0", "1", ... no sign, no fraction, no exponent), or
//     * a full ISO 8601 timestamp with a zone ("2026-01-01T12:00:00Z", "...+02:00"), which
//       resolves to the greatest ingest sequence whose `receivedAt` is at or before it.
//   (`receivedAt` is the live timeline's clock: ingest order is the record, ARCHITECTURE 7.3.)
// - Sequence 0, or a timestamp before the first event, is the empty state (200, at 0).
//   A sequence or timestamp past the head resolves to the head (200). Nothing else is clamped.
// - Missing or malformed `at` is 400 bad_request. `live:<unknown project>` is 404
//   unknown_project; any other timeline id is 404 not_found.
// - Response: { timelineId, at, cursor, reducerVersion, stateHash, state, attention, computedAt }.
//   `at` is the resolved sequence (a number) and `cursor` equals it. `state` and `stateHash`
//   equal a full replay of the project's events 1..at. `attention` is evaluated at the replay
//   clock (the `receivedAt` of event `at`; the engine clock for position 0), not the engine
//   clock; `computedAt` is the engine clock.

const day = useDayEngine();
const dbPath = useDbPath();
let small: Engine | undefined;
afterEach(() => {
  small?.close();
  small = undefined;
});

interface StateBody {
  timelineId: string;
  at: number;
  cursor: number;
  reducerVersion: number;
  stateHash: string;
  state: ProjectState;
  attention: unknown[];
  computedAt: string;
}

const replayTo = (events: readonly StoredEnvelope[], seq: number) =>
  replay("demo", events.slice(0, seq));

/** The greatest sequence whose receivedAt is at or before `ms`; 0 when none is. */
function resolveByTime(events: readonly StoredEnvelope[], ms: number): number {
  let found = 0;
  for (const e of events) if (Date.parse(e.receivedAt) <= ms) found = e.ingestSequence;
  return found;
}

describe("state at a sequence equals a full replay to it (day-sized log)", () => {
  it("matches the domain reducer at the edges, around every 500-event boundary, and mid-log", async () => {
    const { app, events } = day();
    const head = events.length;
    expect(head).toBeGreaterThan(5000);
    const positions = [
      1,
      2,
      3,
      499,
      500,
      501,
      999,
      1000,
      1001,
      2500,
      5000,
      Math.floor(head / 2),
      head - 501,
      head - 1,
      head,
    ];
    for (const at of positions) {
      const { status, body } = await getJson<StateBody>(
        app,
        `/v1/timelines/live:demo/state?at=${at}`,
      );
      expect(status, `at=${at}`).toBe(200);
      const expected = replayTo(events, at);
      expect(body.timelineId).toBe("live:demo");
      expect(body.at).toBe(at);
      expect(body.cursor).toBe(at);
      expect(body.reducerVersion).toBe(REDUCER_VERSION);
      expect(body.stateHash, `stateHash at=${at}`).toBe(projectStateHash(expected));
      expect(body.state, `state at=${at}`).toEqual(expected);
      expect(body.state.head).toBe(at);
      expect(Array.isArray(body.attention)).toBe(true);
      expect(body.computedAt).toBe("2026-01-02T10:00:00.000Z");
    }
  });

  it("at the head equals the stored projection the snapshot route serves", async () => {
    const { app, engine, events } = day();
    const stored = engine.storage.projection<ProjectState>("demo");
    const { body } = await getJson<StateBody>(
      app,
      `/v1/timelines/live:demo/state?at=${events.length}`,
    );
    expect(body.stateHash).toBe(stored?.stateHash);
    expect(body.state).toEqual(stored?.state);
  });

  it("seeks to the same state however it got there (forward, backward, repeated)", async () => {
    const { app, events } = day();
    const order = [8000, 10, 5000, 10, 8000, 1];
    const hashes = new Map<number, string>();
    for (const at of order) {
      const { body } = await getJson<StateBody>(app, `/v1/timelines/live:demo/state?at=${at}`);
      const seen = hashes.get(at);
      if (seen) expect(body.stateHash).toBe(seen);
      hashes.set(at, body.stateHash);
      expect(body.stateHash).toBe(projectStateHash(replayTo(events, at)));
    }
  });

  it("answers a seek in the day-sized log well under a generous bound", async () => {
    // The 300 ms target is measured by tests/perf/seek.ts and posted in the PR; this only guards
    // against a pathological regression, so the bound is deliberately loose.
    const { app, events } = day();
    const started = performance.now();
    const res = await get(app, `/v1/timelines/live:demo/state?at=${events.length}`);
    const elapsed = performance.now() - started;
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(3000);
  });
});

describe("state at a timestamp", () => {
  it("resolves to the last event received at or before it, and says which in `at`", async () => {
    const { app, events } = day();
    for (const index of [0, 1, 700, 4321, events.length - 1]) {
      const event = events[index] as StoredEnvelope;
      const want = resolveByTime(events, Date.parse(event.receivedAt));
      const iso = new Date(Date.parse(event.receivedAt)).toISOString();
      const { status, body } = await getJson<StateBody>(
        app,
        `/v1/timelines/live:demo/state?at=${encodeURIComponent(iso)}`,
      );
      expect(status, iso).toBe(200);
      expect(body.at).toBe(want);
      expect(body.cursor).toBe(want);
      expect(body.stateHash).toBe(projectStateHash(replayTo(events, want)));
    }
  });

  it("takes the greatest sequence when several events share the timestamp, and a moment between events", async () => {
    const { app, events } = day();
    // 1 ms after an event that is followed by a later one.
    const event = events[3000] as StoredEnvelope;
    const between = new Date(Date.parse(event.receivedAt) + 1).toISOString();
    const want = resolveByTime(events, Date.parse(between));
    const { body } = await getJson<StateBody>(
      app,
      `/v1/timelines/live:demo/state?at=${encodeURIComponent(between)}`,
    );
    expect(body.at).toBe(want);
    expect(body.at).toBeGreaterThanOrEqual(event.ingestSequence);
    expect(body.stateHash).toBe(projectStateHash(replayTo(events, want)));
  });

  it("accepts a zone offset and means the same instant", async () => {
    const { app, events } = day();
    const event = events[2000] as StoredEnvelope;
    const ms = Date.parse(event.receivedAt);
    const plusTwo = `${new Date(ms + 2 * 3_600_000).toISOString().replace("Z", "")}+02:00`;
    const zulu = new Date(ms).toISOString();
    const a = await getJson<StateBody>(
      app,
      `/v1/timelines/live:demo/state?at=${encodeURIComponent(plusTwo)}`,
    );
    const b = await getJson<StateBody>(
      app,
      `/v1/timelines/live:demo/state?at=${encodeURIComponent(zulu)}`,
    );
    expect(a.status).toBe(200);
    expect(a.body.at).toBe(b.body.at);
    expect(a.body.stateHash).toBe(b.body.stateHash);
  });
});

describe("positions before the first event and past the head", () => {
  it("sequence 0 is the empty state at cursor 0", async () => {
    const { app } = day();
    const { status, body } = await getJson<StateBody>(app, "/v1/timelines/live:demo/state?at=0");
    expect(status).toBe(200);
    expect(body.at).toBe(0);
    expect(body.cursor).toBe(0);
    const empty = replay("demo", []);
    expect(body.stateHash).toBe(projectStateHash(empty));
    expect(body.state).toEqual(empty);
  });

  it("a timestamp before the first event is also the empty state", async () => {
    const { app, events } = day();
    const first = Date.parse((events[0] as StoredEnvelope).receivedAt);
    const before = new Date(first - 1).toISOString();
    const { status, body } = await getJson<StateBody>(
      app,
      `/v1/timelines/live:demo/state?at=${encodeURIComponent(before)}`,
    );
    expect(status).toBe(200);
    expect(body.at).toBe(0);
    expect(body.stateHash).toBe(projectStateHash(replay("demo", [])));
  });

  it("a sequence or timestamp past the head resolves to the head", async () => {
    const { app, events } = day();
    const head = events.length;
    const expected = projectStateHash(replayTo(events, head));
    for (const at of [String(head + 1), String(head + 100000), "2030-01-01T00:00:00Z"]) {
      const { status, body } = await getJson<StateBody>(
        app,
        `/v1/timelines/live:demo/state?at=${encodeURIComponent(at)}`,
      );
      expect(status, at).toBe(200);
      expect(body.at, at).toBe(head);
      expect(body.cursor, at).toBe(head);
      expect(body.stateHash, at).toBe(expected);
    }
  });
});

describe("invalid requests", () => {
  it("rejects a missing or malformed `at` with 400 bad_request", async () => {
    const { app } = day();
    const bad = [
      "",
      "abc",
      "-1",
      "+1",
      "1.5",
      "1e3",
      "0x10",
      "99999999999999999999999",
      "2026-01-01",
      "2026-01-01T10:00:00",
      "2026-13-45T00:00:00Z",
      "yesterday",
      "10:00",
    ];
    const paths = [
      "/v1/timelines/live:demo/state",
      ...bad.map((v) => `/v1/timelines/live:demo/state?at=${encodeURIComponent(v)}`),
    ];
    for (const path of paths) {
      const { status, body } = await getJson<{ error: { code: string; message: string } }>(
        app,
        path,
      );
      expect(status, path).toBe(400);
      expect(body.error.code, path).toBe("bad_request");
    }
  });

  it("answers 404 unknown_project for a live timeline of an unknown project, 404 not_found for any other id", async () => {
    const { app } = day();
    const unknown = await getJson<{ error: { code: string } }>(
      app,
      "/v1/timelines/live:ghost/state?at=1",
    );
    expect(unknown.status).toBe(404);
    expect(unknown.body.error.code).toBe("unknown_project");
    for (const id of ["demo", "archive:abc", "nonsense", "live:"]) {
      const other = await getJson<{ error: { code: string } }>(
        app,
        `/v1/timelines/${id}/state?at=1`,
      );
      expect(other.status, id).toBe(404);
      expect(other.body.error.code, id).toBe("not_found");
    }
  });
});

describe("attention is evaluated at the replay clock", () => {
  const T = Date.parse("2026-10-30T11:00:00Z");

  it("does not call an agent silent just because the engine clock has moved on", async () => {
    let now = T;
    const booted = bootInProcess(dbPath(), { now: () => new Date(now) });
    small = booted.engine;
    addProject(small.storage, "demo");
    await ingest(booted.app, [input("c1")]);
    const head = small.storage.head("demo") ?? 0;

    // Eleven minutes later the live snapshot flags the quiet agent as silent trouble...
    now = T + 11 * 60_000;
    const live = await getJson<{ attention: Array<{ kind: string }> }>(
      booted.app,
      "/v1/projects/demo/snapshot",
    );
    expect(live.body.attention.map((a) => a.kind)).toContain("silent");

    // ...but history asks what it looked like at the moment of the event.
    const { status, body } = await getJson<StateBody>(
      booted.app,
      `/v1/timelines/live:demo/state?at=${head}`,
    );
    expect(status).toBe(200);
    const events = [...small.storage.events("demo")];
    const state = replay("demo", events);
    const atEvent = Date.parse((events.at(-1) as StoredEnvelope).receivedAt);
    expect(body.attention).toEqual(JSON.parse(JSON.stringify(attention(state, atEvent))));
    expect(body.attention).not.toContainEqual(expect.objectContaining({ kind: "silent" }));
    expect(body.computedAt).toBe("2026-10-30T11:11:00.000Z");
  });
});
