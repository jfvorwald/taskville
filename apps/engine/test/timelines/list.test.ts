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

// GET /v1/projects/:id/timelines  (M6.01).
//
// Pinned contract:
// - 200 { projectId, timelines: [ { id, kind, projectId, firstSequence, lastSequence,
//   firstAt, lastAt, eventCount } ] }. Today the list is exactly one timeline: the live
//   recording, id `live:<projectId>`, kind "live". Archive timelines arrive with M8.
// - firstSequence/lastSequence are the first and last ingest sequences (1 and the head);
//   firstAt/lastAt are the `receivedAt` of those events (the live timeline's clock);
//   eventCount is lastSequence (the log has no gaps).
// - Every project has the timeline, including the built-in Unsorted. Unknown project: 404
//   unknown_project. The range follows the head as events are ingested.

const dbPath = useDbPath();
let engine: Engine | undefined;
afterEach(() => {
  engine?.close();
  engine = undefined;
});

// addProject stamps project.created at 12:00:00Z, so the clock starts there and only moves forward.
const T = Date.parse("2026-10-30T12:00:00Z");

interface ListBody {
  projectId: string;
  timelines: Array<{
    id: string;
    kind: string;
    projectId: string;
    firstSequence: number;
    lastSequence: number;
    firstAt: string;
    lastAt: string;
    eventCount: number;
  }>;
}

describe("GET /v1/projects/:id/timelines", () => {
  it("lists the live recording with its range", async () => {
    let now = T;
    const booted = bootInProcess(dbPath(), { now: () => new Date(now) });
    engine = booted.engine;
    addProject(engine.storage, "demo");
    now = T + 5_000;
    await ingest(booted.app, [input("e1"), input("e2")]);
    now = T + 9_000;
    await ingest(booted.app, [input("e3")]);

    const { status, body } = await getJson<ListBody>(booted.app, "/v1/projects/demo/timelines");
    expect(status).toBe(200);
    const events = [...engine.storage.events("demo")] as StoredEnvelope[];
    expect(events).toHaveLength(4);
    expect(body).toEqual({
      projectId: "demo",
      timelines: [
        {
          id: "live:demo",
          kind: "live",
          projectId: "demo",
          firstSequence: 1,
          lastSequence: 4,
          firstAt: events[0]?.receivedAt,
          lastAt: new Date(T + 9_000).toISOString(),
          eventCount: 4,
        },
      ],
    });
  });

  it("follows the head as events arrive", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    addProject(engine.storage, "demo");
    const before = await getJson<ListBody>(booted.app, "/v1/projects/demo/timelines");
    expect(before.body.timelines[0]?.lastSequence).toBe(1);
    expect(before.body.timelines[0]?.firstSequence).toBe(1);
    expect(before.body.timelines[0]?.eventCount).toBe(1);

    await ingest(booted.app, [input("e1"), input("e2"), input("e3")]);
    const after = await getJson<ListBody>(booted.app, "/v1/projects/demo/timelines");
    expect(after.body.timelines[0]?.lastSequence).toBe(4);
    expect(after.body.timelines[0]?.eventCount).toBe(4);
  });

  it("is available for the built-in Unsorted project", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    const { status, body } = await getJson<ListBody>(booted.app, "/v1/projects/unsorted/timelines");
    expect(status).toBe(200);
    expect(body.timelines.map((t) => t.id)).toEqual(["live:unsorted"]);
  });

  it("answers 404 unknown_project for a project that does not exist", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    const { status, body } = await getJson<{ error: { code: string } }>(
      booted.app,
      "/v1/projects/ghost/timelines",
    );
    expect(status).toBe(404);
    expect(body.error.code).toBe("unknown_project");
  });

  it("lists only that project's timeline", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    addProject(engine.storage, "demo");
    addProject(engine.storage, "other");
    const { body } = await getJson<ListBody>(booted.app, "/v1/projects/other/timelines");
    expect(body.timelines.map((t) => t.id)).toEqual(["live:other"]);
    expect(body.timelines.every((t) => t.projectId === "other")).toBe(true);
  });
});
