import { type ProjectState, projectStateHash, replay } from "@taskville/domain/reducer";
import { projectsResponseSchema, snapshotResponseSchema } from "@taskville/protocol";
import { afterEach, describe, expect, it } from "vitest";
import { BRIDGE_TOKEN, bearer, CLI_TOKEN, HOST, ORIGIN, sessionHeaders } from "../http/helpers.ts";
import {
  addProject,
  BASE,
  bootInProcess,
  type Engine,
  ingest,
  input,
  useDbPath,
} from "./helpers.ts";

const dbPath = useDbPath();
let engine: Engine | undefined;
afterEach(() => {
  engine?.close();
  engine = undefined;
});

const AT = Date.parse("2026-10-30T11:00:00Z");

describe("GET /v1/projects", () => {
  it("lists every project with roots, builtin flag, and head; Unsorted always", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    addProject(engine.storage, "demo");
    await ingest(booted.app, [input("e1"), input("e2")]);

    const res = await booted.app.request(`${BASE}/v1/projects`, { headers: bearer(CLI_TOKEN) });
    expect(res.status).toBe(200);
    const body = projectsResponseSchema.parse(await res.json());
    expect(body.projects).toEqual([
      { id: "demo", name: "demo", roots: [], builtin: false, head: 3 },
      { id: "unsorted", name: "Unsorted", roots: [], builtin: true, head: 1 },
    ]);
  });

  it("accepts a paired browser session and refuses the bridge token", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    const session = booted.pairing.exchange(booted.pairing.issueCode()) ?? "";
    const ok = await booted.app.request(`${BASE}/v1/projects`, {
      headers: sessionHeaders(session),
    });
    expect(ok.status).toBe(200);
    const bridge = await booted.app.request(`${BASE}/v1/projects`, {
      headers: bearer(BRIDGE_TOKEN),
    });
    expect(bridge.status).toBe(403);
    const anonymous = await booted.app.request(`${BASE}/v1/projects`, { headers: { Host: HOST } });
    expect(anonymous.status).toBe(401);
  });
});

describe("GET /v1/projects/:id/snapshot", () => {
  it("returns the stored projection with its head as the cursor", async () => {
    const booted = bootInProcess(dbPath(), { now: () => new Date(AT) });
    engine = booted.engine;
    addProject(engine.storage, "demo");
    await ingest(booted.app, [
      input("r1", {
        type: "agent.registered",
        payload: {
          sourceAgentId: "s1",
          displayName: "Builder",
          role: "implementer",
          kind: "session",
        },
      }),
      input("c1"),
    ]);

    const res = await booted.app.request(`${BASE}/v1/projects/demo/snapshot`, {
      headers: bearer(CLI_TOKEN),
    });
    expect(res.status).toBe(200);
    const body = snapshotResponseSchema.parse(await res.json());
    const stored = engine.storage.projection<ProjectState>("demo");
    expect(body.projectId).toBe("demo");
    expect(body.cursor).toBe(3);
    expect(body.cursor).toBe(stored?.head);
    expect(body.stateHash).toBe(stored?.stateHash);
    expect(body.state).toEqual(stored?.state);
    expect(body.reducerVersion).toBe(stored?.reducerVersion);
    expect(body.computedAt).toBe("2026-10-30T11:00:00.000Z");
  });

  it("computes attention at read time with the injected clock, outside stateHash", async () => {
    let now = AT;
    const booted = bootInProcess(dbPath(), { now: () => new Date(now) });
    engine = booted.engine;
    addProject(engine.storage, "demo");
    await ingest(booted.app, [input("c1")]);

    const read = async () =>
      snapshotResponseSchema.parse(
        await (
          await booted.app.request(`${BASE}/v1/projects/demo/snapshot`, {
            headers: bearer(CLI_TOKEN),
          })
        ).json(),
      );
    const early = await read();
    now = AT + 11 * 60_000;
    const late = await read();

    expect(early.attention).toEqual([]);
    expect(late.attention).toEqual([
      expect.objectContaining({
        agentId: "agent-1",
        level: "trouble",
        kind: "silent",
        heuristic: true,
      }),
    ]);
    expect(late.stateHash).toBe(early.stateHash);
    expect(late.computedAt).toBe("2026-10-30T11:11:00.000Z");
  });

  it("serves a project whose projection does not exist yet by replaying its log", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    addProject(engine.storage, "fresh");
    const res = await booted.app.request(`${BASE}/v1/projects/fresh/snapshot`, {
      headers: bearer(CLI_TOKEN),
    });
    const body = snapshotResponseSchema.parse(await res.json());
    expect(body.cursor).toBe(1);
    expect(body.stateHash).toBe(projectStateHash(replay("fresh", engine.storage.events("fresh"))));
  });

  it("answers 404 unknown_project for a project that does not exist", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    const res = await booted.app.request(`${BASE}/v1/projects/ghost/snapshot`, {
      headers: bearer(CLI_TOKEN),
    });
    expect(res.status).toBe(404);
    expect(await res.json()).toEqual({
      error: expect.objectContaining({ code: "unknown_project" }),
    });
  });

  it("refuses the bridge token and accepts a browser session", async () => {
    const booted = bootInProcess(dbPath());
    engine = booted.engine;
    const session = booted.pairing.exchange(booted.pairing.issueCode()) ?? "";
    const url = `${BASE}/v1/projects/unsorted/snapshot`;
    expect((await booted.app.request(url, { headers: bearer(BRIDGE_TOKEN) })).status).toBe(403);
    expect(
      (await booted.app.request(url, { headers: { ...sessionHeaders(session), Origin: ORIGIN } }))
        .status,
    ).toBe(200);
  });
});
