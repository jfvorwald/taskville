import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createProjectResponseSchema, storedEnvelopeSchema } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createProject, registerProjectRoutes } from "../../src/projects/index.ts";
import { ensureUnsortedProject, openStorage, type Storage } from "../../src/storage/index.ts";
import {
  BRIDGE_TOKEN,
  bearer,
  CLI_TOKEN,
  HOST,
  makeApp,
  ORIGIN,
  postJson,
  sessionHeaders,
} from "../http/helpers.ts";

const T0 = "2026-10-30T12:00:00.000Z";
const now = () => new Date(T0);

let dir = "";
let storage: Storage;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "taskville-projects-"));
  storage = openStorage(join(dir, "taskville.db"), { now });
  ensureUnsortedProject(storage, { now });
});
afterEach(() => {
  storage.close();
  rmSync(dir, { recursive: true, force: true });
});

function app() {
  const made = makeApp();
  registerProjectRoutes(made.app, { storage, now });
  return made;
}

describe("createProject", () => {
  it("inserts the project and its project.created event at sequence 1 in one transaction", () => {
    expect(
      createProject(storage, { id: "demo", name: "Demo", roots: ["/repo/demo"] }, { now }),
    ).toBe(true);
    expect(storage.project("demo")).toMatchObject({
      id: "demo",
      name: "Demo",
      roots: ["/repo/demo"],
      builtin: false,
      head: 1,
    });
    const [created] = [...storage.events("demo")];
    expect(storedEnvelopeSchema.parse(created)).toMatchObject({
      type: "project.created",
      ingestSequence: 1,
      sourceId: "taskville:engine",
      sourceEventId: "project.created:demo",
      occurredAt: T0,
      payload: { name: "Demo", roots: ["/repo/demo"], builtin: false },
    });
  });

  it("returns false and changes nothing when the ID exists", () => {
    createProject(storage, { id: "demo", name: "Demo", roots: [] }, { now });
    expect(createProject(storage, { id: "demo", name: "Other", roots: ["/x"] }, { now })).toBe(
      false,
    );
    expect(storage.project("demo")?.name).toBe("Demo");
    expect(createProject(storage, { id: "unsorted", name: "Mine", roots: [] }, { now })).toBe(
      false,
    );
  });
});

describe("POST /v1/projects", () => {
  it("creates a project with the CLI token and answers 201 with head 1", async () => {
    const res = await app().app.request(
      "/v1/projects",
      postJson({ name: "My App", roots: ["/repo/app"] }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(201);
    const body = createProjectResponseSchema.parse(await res.json());
    expect(body).toEqual({ id: "my-app", name: "My App", roots: ["/repo/app"], head: 1 });
    expect(storage.project("my-app")?.head).toBe(1);
  });

  it("takes an explicit ID", async () => {
    const res = await app().app.request(
      "/v1/projects",
      postJson({ id: "tv", name: "Taskville", roots: [] }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(201);
    expect(storage.project("tv")?.name).toBe("Taskville");
  });

  it("answers 409 project_exists for a taken ID, including unsorted", async () => {
    const { app: a } = app();
    await a.request(
      "/v1/projects",
      postJson({ id: "demo", name: "Demo", roots: [] }, bearer(CLI_TOKEN)),
    );
    for (const id of ["demo", "unsorted"]) {
      const res = await a.request(
        "/v1/projects",
        postJson({ id, name: "X", roots: [] }, bearer(CLI_TOKEN)),
      );
      expect(res.status).toBe(409);
      expect(await res.json()).toMatchObject({ error: { code: "project_exists" } });
    }
  });

  it.each([
    ["no name", { roots: [] }],
    ["relative root", { name: "A", roots: ["repo"] }],
    ["bad ID", { id: "Has Space", name: "A", roots: [] }],
    ["name with no slug", { name: "!!!", roots: [] }],
    ["unknown field", { name: "A", roots: [], extra: 1 }],
    ["name over 100 characters", { name: "n".repeat(101), roots: [] }],
  ])("answers 400 for %s", async (_label, body) => {
    const res = await app().app.request("/v1/projects", postJson(body, bearer(CLI_TOKEN)));
    expect(res.status).toBe(400);
    expect(await res.json()).toMatchObject({ error: { code: "bad_request" } });
  });

  it("refuses a browser session and the bridge token, and requires a credential", async () => {
    const made = app();
    const session = made.pairing.exchange(made.pairing.issueCode()) ?? "";
    const body = { name: "A", roots: [] };
    const asSession = await made.app.request(
      "/v1/projects",
      postJson(body, { ...sessionHeaders(session), Origin: ORIGIN }),
    );
    expect(asSession.status).toBe(403);
    const asBridge = await made.app.request("/v1/projects", postJson(body, bearer(BRIDGE_TOKEN)));
    expect(asBridge.status).toBe(403);
    const anonymous = await made.app.request(
      "/v1/projects",
      postJson(body, { Host: HOST, Origin: ORIGIN }),
    );
    expect(anonymous.status).toBe(401);
    expect(storage.project("a")).toBeUndefined();
  });

  it("refuses a foreign Host", async () => {
    const res = await app().app.request(
      "/v1/projects",
      postJson({ name: "A", roots: [] }, { ...bearer(CLI_TOKEN), Host: "evil.example:4807" }),
    );
    expect(res.status).toBe(403);
  });
});
