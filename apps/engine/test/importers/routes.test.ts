import { mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { apiErrorSchema, importStartedSchema, importStatusSchema } from "@taskville/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { type ImportJobs, registerImportRoutes } from "../../src/importers/index.ts";
import {
  BRIDGE_TOKEN,
  bearer,
  CLI_TOKEN,
  HOST,
  ORIGIN,
  postJson,
  sessionHeaders,
} from "../http/helpers.ts";
import { addProject, BASE, bootInProcess, type Engine } from "../stream/helpers.ts";
import {
  commitEvent,
  fakeImporter,
  gatedImporter,
  type ImportsEnv,
  makeJobs,
  PROJECT,
} from "./helpers.ts";

// POST /v1/imports and GET /v1/imports/:id (M8.06), through the real app middleware.
//
// Pinned contract (imports-design.md, Imports API):
// - POST { projectId, kind, root }: CLI token only. 202 { importId, archiveId, status: "running" }.
//   Bridge token and a paired browser session: 403 credential_not_allowed. Root not among the
//   project's configured roots after realpath: 400 root_not_configured. A second import while one
//   runs for the project: 409 import_running. A kind with no importer: 400 unknown_import_kind.
//   Unknown project: 404 unknown_project. Malformed body: 400 bad_request.
// - GET /:id: CLI token or paired session (bridge: 403). 200 { importId, archiveId, projectId, kind,
//   status, counts, error?, startedAt, finishedAt? }. Unknown ID: 404 not_found.

let dir = "";
let root = "";
let engine: Engine;
let app: ReturnType<typeof bootInProcess>["app"];
let pairing: ReturnType<typeof bootInProcess>["pairing"];
let jobs: ImportJobs | undefined;

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), "taskville-imports-http-")));
  root = join(dir, "repo");
  mkdirSync(root);
  const booted = bootInProcess(join(dir, "taskville.db"));
  engine = booted.engine;
  app = booted.app;
  pairing = booted.pairing;
  addProject(engine.storage, PROJECT, [root]);
});

afterEach(async () => {
  await jobs?.close();
  jobs = undefined;
  engine.close();
  rmSync(dir, { recursive: true, force: true });
});

function setup(importers: Parameters<typeof makeJobs>[1]) {
  const env: ImportsEnv = { dir, root, storage: engine.storage, dbPath: join(dir, "taskville.db") };
  jobs = makeJobs(env, importers);
  registerImportRoutes(app, jobs);
  return jobs;
}

const cli = () => ({ ...bearer(CLI_TOKEN) });
const bridge = () => ({ ...bearer(BRIDGE_TOKEN) });
function session() {
  const secret = pairing.exchange(pairing.issueCode());
  if (secret === null) throw new Error("pairing failed");
  return { ...sessionHeaders(secret), Origin: ORIGIN };
}

function post(body: unknown, headers: Record<string, string> = cli()) {
  return app.request(`${BASE}/v1/imports`, postJson(body, headers));
}

function get(id: string, headers: Record<string, string> = cli()) {
  return app.request(`${BASE}/v1/imports/${id}`, { headers });
}

const request = (overrides: Record<string, unknown> = {}) => ({
  projectId: PROJECT,
  kind: "git",
  root,
  ...overrides,
});

const oneEvent = () => ({ events: [commitEvent("a", "2026-11-01T10:00:00Z")] });

describe("POST /v1/imports", () => {
  it("starts an import for the CLI token: 202 with the IDs and status running", async () => {
    const gate = gatedImporter(oneEvent());
    setup([gate.importer]);
    const res = await post(request());
    expect(res.status).toBe(202);
    const body = importStartedSchema.parse(await res.json());
    expect(body.status).toBe("running");
    expect(body.importId).toBe(body.archiveId);
    gate.release();
  });

  it("runs the job off the request: the answer comes before the importer finishes", async () => {
    const gate = gatedImporter(oneEvent());
    setup([gate.importer]);
    const res = await post(request());
    expect(res.status).toBe(202);
    const { importId } = importStartedSchema.parse(await res.json());
    await gate.started;
    const running = await get(importId);
    expect(running.status).toBe(200);
    expect(importStatusSchema.parse(await running.json())).toMatchObject({
      status: "running",
      counts: { read: 3, imported: 3 },
    });
    gate.release();
  });

  it("accepts a root given through a symlink to a configured root", async () => {
    setup([fakeImporter([oneEvent()])]);
    const link = join(dir, "link");
    symlinkSync(root, link);
    const res = await post(request({ root: link }));
    expect(res.status).toBe(202);
  });

  it("refuses the bridge token and a paired browser session with credential_not_allowed", async () => {
    setup([fakeImporter([oneEvent()])]);
    for (const headers of [{ ...bridge(), "Content-Type": "application/json" }, session()]) {
      const res = await post(request(), headers);
      expect(res.status).toBe(403);
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe("credential_not_allowed");
    }
    expect(engine.storage.archives().running(PROJECT)).toBeUndefined();
  });

  it("refuses a request without credentials", async () => {
    setup([fakeImporter([oneEvent()])]);
    const res = await app.request(`${BASE}/v1/imports`, postJson(request(), { Host: HOST }));
    expect(res.status).toBe(401);
  });

  it("refuses a root that is not one of the project's configured roots", async () => {
    setup([fakeImporter([oneEvent()])]);
    const other = join(dir, "other");
    mkdirSync(other);
    for (const bad of [other, `${root}/../other`, join(dir, "missing"), dir]) {
      const res = await post(request({ root: bad }));
      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe("root_not_configured");
    }
  });

  it("refuses a second import while one is running, with 409 import_running", async () => {
    const gate = gatedImporter(oneEvent());
    setup([gate.importer]);
    expect((await post(request())).status).toBe(202);
    const second = await post(request());
    expect(second.status).toBe(409);
    expect(apiErrorSchema.parse(await second.json()).error.code).toBe("import_running");
    gate.release();
  });

  it("refuses a kind with no registered importer: 400 unknown_import_kind", async () => {
    setup([fakeImporter([oneEvent()], { kind: "git" })]);
    const res = await post(request({ kind: "transcripts" }));
    expect(res.status).toBe(400);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe("unknown_import_kind");
    const nonsense = await post(request({ kind: "svn" }));
    expect(nonsense.status).toBe(400);
    expect(apiErrorSchema.parse(await nonsense.json()).error.code).toBe("unknown_import_kind");
  });

  it("refuses an unknown project and a malformed body", async () => {
    setup([fakeImporter([oneEvent()])]);
    const unknown = await post(request({ projectId: "nope" }));
    expect(unknown.status).toBe(404);
    expect(apiErrorSchema.parse(await unknown.json()).error.code).toBe("unknown_project");
    for (const body of [{}, { projectId: PROJECT }, request({ root: 5 }), request({ extra: 1 })]) {
      const res = await post(body);
      expect(res.status).toBe(400);
      expect(apiErrorSchema.parse(await res.json()).error.code).toBe("bad_request");
    }
    const notJson = await app.request(`${BASE}/v1/imports`, {
      method: "POST",
      headers: { ...cli(), "Content-Type": "application/json" },
      body: "{nope",
    });
    expect(notJson.status).toBe(400);
  });
});

describe("GET /v1/imports/:id", () => {
  async function finishedImport() {
    setup([
      fakeImporter([{ events: [commitEvent("a", "2026-11-01T10:00:00Z")] }], {
        final: { read: 2, imported: 1, skipped: 0, malformed: 1 },
      }),
    ]);
    const res = await post(request());
    const { importId, archiveId } = importStartedSchema.parse(await res.json());
    await jobs?.settled(importId);
    return { importId, archiveId };
  }

  it("returns the status and counts to the CLI token and to a paired session", async () => {
    const { importId, archiveId } = await finishedImport();
    for (const headers of [cli(), session()]) {
      const res = await get(importId, headers);
      expect(res.status).toBe(200);
      const body = importStatusSchema.parse(await res.json());
      expect(body).toMatchObject({
        importId,
        archiveId,
        projectId: PROJECT,
        kind: "git",
        status: "done",
        counts: { read: 2, imported: 1, skipped: 0, malformed: 1 },
      });
      expect(typeof body.startedAt).toBe("string");
      expect(typeof body.finishedAt).toBe("string");
      expect(body.error).toBeUndefined();
    }
  });

  it("reports a failed import with its error code", async () => {
    setup([
      {
        kind: "git",
        // biome-ignore lint/correctness/useYield: fails before yielding anything
        async *run() {
          throw new Error("boom");
        },
      },
    ]);
    const { importId } = importStartedSchema.parse(await (await post(request())).json());
    await jobs?.settled(importId);
    const body = importStatusSchema.parse(await (await get(importId)).json());
    expect(body.status).toBe("failed");
    expect(body.error?.code).toBe("importer_failed");
  });

  it("refuses the bridge token", async () => {
    const { importId } = await finishedImport();
    const res = await get(importId, bridge());
    expect(res.status).toBe(403);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe("credential_not_allowed");
  });

  it("answers 404 not_found for an unknown import", async () => {
    setup([fakeImporter([])]);
    const res = await get("00000000-0000-4000-8000-000000000000");
    expect(res.status).toBe(404);
    expect(apiErrorSchema.parse(await res.json()).error.code).toBe("not_found");
  });

  it("answers 401 without credentials", async () => {
    setup([fakeImporter([])]);
    const res = await app.request(`${BASE}/v1/imports/x`, { headers: { Host: HOST } });
    expect(res.status).toBe(401);
  });
});

describe("the live timeline after an import", () => {
  it("keeps the live head, events and projection as they were", async () => {
    const before = {
      head: engine.storage.head(PROJECT),
      events: [...engine.storage.events(PROJECT)],
      projection: engine.storage.projection(PROJECT),
    };
    setup([fakeImporter([oneEvent()])]);
    const { importId } = importStartedSchema.parse(await (await post(request())).json());
    const finished = await jobs?.settled(importId);
    expect(finished?.status).toBe("done");
    expect(engine.storage.head(PROJECT)).toBe(before.head);
    expect([...engine.storage.events(PROJECT)]).toEqual(before.events);
    expect(engine.storage.projection(PROJECT)).toEqual(before.projection);
  });
});
