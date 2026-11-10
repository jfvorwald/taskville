// Read routes are backed by a seeded packages/demo run, in the engine's shapes.

import { projectStateHash, replay } from "@taskville/domain/reducer";
import {
  projectsResponseSchema,
  type StoredEnvelope,
  snapshotResponseSchema,
  sseFrameSchema,
} from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { makeStaging, pair, type RawFrame, readSse, withSession } from "./support.ts";

async function snapshotOf(staging: ReturnType<typeof makeStaging>, session: string, id: string) {
  const response = await staging.call(`/v1/projects/${id}/snapshot`, withSession(session));
  expect(response.status).toBe(200);
  return snapshotResponseSchema.parse(await response.json());
}

async function firstProjectId(staging: ReturnType<typeof makeStaging>, session: string) {
  const response = await staging.call("/v1/projects", withSession(session));
  expect(response.status).toBe(200);
  const body = projectsResponseSchema.parse(await response.json());
  const project = body.projects[0];
  expect(project, "the demo project").toBeDefined();
  return { project: project as NonNullable<typeof project>, body };
}

function toFrames(frames: RawFrame[]) {
  return frames.map((frame) =>
    sseFrameSchema.parse({
      event: frame.event,
      ...(frame.id === undefined ? {} : { id: Number(frame.id) }),
      data: JSON.parse(frame.data),
    }),
  );
}

describe("seeded demo reads", () => {
  it("lists a demo project with events", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const { project, body } = await firstProjectId(staging, session);
    expect(body.projects.length).toBeGreaterThanOrEqual(1);
    expect(project.head).toBeGreaterThan(0);
    expect(project.name.length).toBeGreaterThan(0);
  });

  it("serves a snapshot with agents, in the engine's schema", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const { project } = await firstProjectId(staging, session);
    const snapshot = await snapshotOf(staging, session, project.id);
    expect(snapshot.projectId).toBe(project.id);
    expect(snapshot.cursor).toBe(project.head);
    const agents = snapshot.state.agents as Record<string, unknown>;
    expect(Object.keys(agents).length).toBeGreaterThan(0);
  });

  it("streams project events in the engine's SSE format, gap-free, matching the snapshot", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const { project } = await firstProjectId(staging, session);
    const snapshot = await snapshotOf(staging, session, project.id);

    const response = await staging.call(
      `/v1/projects/${project.id}/events?after=0`,
      withSession(session, { headers: { Accept: "text/event-stream" } }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const raw = await readSse(
      response,
      (frames) => frames.filter((f) => f.event === "event").length >= snapshot.cursor,
    );

    // Wire format of Hono's `writeSSE`, which the engine uses: event, one data line, id.
    for (const frame of raw.filter((f) => f.event === "event")) {
      expect(frame.raw).toMatch(/^event: event\ndata: \{.*\}\nid: \d+\n\n$/);
    }
    const frames = toFrames(raw);
    const events = frames.flatMap((frame) => (frame.event === "event" ? [frame.data] : []));
    expect(events.length).toBe(snapshot.cursor);
    expect(events.map((e) => e.ingestSequence)).toEqual(
      Array.from({ length: events.length }, (_, i) => i + 1),
    );
    // Replaying the streamed events reproduces the snapshot: one source of truth.
    const state = replay(project.id, events as StoredEnvelope[]);
    expect(projectStateHash(state)).toBe(snapshot.stateHash);
  });

  it("resumes after a cursor", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const { project } = await firstProjectId(staging, session);
    const response = await staging.call(
      `/v1/projects/${project.id}/events?after=${project.head - 1}`,
      withSession(session),
    );
    const raw = await readSse(response, (frames) => frames.some((f) => f.event === "event"));
    const events = toFrames(raw).flatMap((frame) => (frame.event === "event" ? [frame.data] : []));
    expect(events.map((e) => e.ingestSequence)).toEqual([project.head]);
  });

  it("answers a cursor ahead of the head with a resnapshot frame, as the engine does", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const { project } = await firstProjectId(staging, session);
    const response = await staging.call(
      `/v1/projects/${project.id}/events?after=${project.head + 1000}`,
      withSession(session),
    );
    const raw = await readSse(response, (frames) => frames.length >= 1);
    expect(toFrames(raw)[0]).toEqual({
      event: "resnapshot",
      data: { reason: "cursor_ahead_of_head" },
    });
  });

  it("answers an unknown project with the engine's 404 error shape", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const response = await staging.call(
      "/v1/projects/no-such-project/snapshot",
      withSession(session),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toEqual({
      error: { code: "unknown_project", message: expect.any(String) },
    });
  });

  it("opens the attention stream with a snapshot frame covering the demo project", async () => {
    const staging = makeStaging();
    const session = await pair(staging);
    const { project } = await firstProjectId(staging, session);
    const response = await staging.call("/v1/attention/events", withSession(session));
    expect(response.headers.get("content-type")).toContain("text/event-stream");
    const raw = await readSse(response, (frames) => frames.length >= 1);
    expect(raw[0]?.event).toBe("snapshot");
    const data = JSON.parse(raw[0]?.data ?? "{}") as {
      projects: { projectId: string }[];
      computedAt: string;
    };
    expect(data.projects.map((p) => p.projectId)).toContain(project.id);
    expect(Number.isNaN(Date.parse(data.computedAt))).toBe(false);
  });
});
