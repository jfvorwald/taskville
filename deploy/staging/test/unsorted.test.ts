// The engine's builtin empty `unsorted` project is listed beside `demo` and answers like the
// engine's empty project on every read, never a 404.

import {
  projectsResponseSchema,
  snapshotResponseSchema,
  sseFrameSchema,
} from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { makeStaging, pair, readSse, withSession } from "./support.ts";

async function setup() {
  const staging = makeStaging();
  const session = await pair(staging);
  return { staging, session };
}

describe("builtin unsorted project", () => {
  it("is listed beside demo, builtin and empty", async () => {
    const { staging, session } = await setup();
    const response = await staging.call("/v1/projects", withSession(session));
    const body = projectsResponseSchema.parse(await response.json());
    const unsorted = body.projects.find((p) => p.id === "unsorted");
    expect(unsorted).toMatchObject({ id: "unsorted", name: "Unsorted", builtin: true, head: 0 });
    expect(unsorted?.lastEventAt).toBeNull();
    const demo = body.projects.find((p) => p.id === "demo");
    expect(demo?.builtin).toBe(false);
    expect(demo?.head).toBeGreaterThan(0);
  });

  it("serves an empty snapshot", async () => {
    const { staging, session } = await setup();
    const response = await staging.call("/v1/projects/unsorted/snapshot", withSession(session));
    expect(response.status).toBe(200);
    const snapshot = snapshotResponseSchema.parse(await response.json());
    expect(snapshot.projectId).toBe("unsorted");
    expect(snapshot.cursor).toBe(0);
    expect(snapshot.attention).toEqual([]);
    expect(Object.keys(snapshot.state.agents as object)).toEqual([]);
  });

  it("opens an event stream with no events from the start", async () => {
    const { staging, session } = await setup();
    const response = await staging.call(
      "/v1/projects/unsorted/events?after=0",
      withSession(session),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const frames = await readSse(response, (all) => all.length >= 1, 300);
    expect(frames.filter((f) => f.event === "event")).toEqual([]);
  });

  it("answers a cursor ahead of its head with a resnapshot", async () => {
    const { staging, session } = await setup();
    const response = await staging.call(
      "/v1/projects/unsorted/events?after=1",
      withSession(session),
    );
    const [frame] = await readSse(response, (all) => all.length >= 1);
    expect(
      frame && sseFrameSchema.parse({ event: frame.event, data: JSON.parse(frame.data) }),
    ).toEqual({
      event: "resnapshot",
      data: { reason: "cursor_ahead_of_head" },
    });
  });

  it("has no timelines, as an empty project does in the engine", async () => {
    const { staging, session } = await setup();
    const response = await staging.call("/v1/projects/unsorted/timelines", withSession(session));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ projectId: "unsorted", timelines: [] });
  });

  it("appears in the attention stream's first frame with nothing needing attention", async () => {
    const { staging, session } = await setup();
    const response = await staging.call("/v1/attention/events", withSession(session));
    const [frame] = await readSse(response, (all) => all.length >= 1);
    expect(frame?.event).toBe("snapshot");
    const data = JSON.parse(frame?.data ?? "{}") as {
      projects: { projectId: string; name: string; attention: unknown[] }[];
    };
    expect(data.projects.find((p) => p.projectId === "unsorted")).toEqual({
      projectId: "unsorted",
      name: "Unsorted",
      attention: [],
    });
    expect(data.projects.map((p) => p.projectId)).toContain("demo");
  });

  it("still 404s a project that does not exist", async () => {
    const { staging, session } = await setup();
    const response = await staging.call("/v1/projects/other/snapshot", withSession(session));
    expect(response.status).toBe(404);
  });
});
