import pino from "pino";
import { describe, expect, it } from "vitest";
import {
  CLAUDE_CODE_HOOKS_PATH,
  CLAUDE_CODE_SOURCE_ID,
  type HookEvidence,
  type HookIngestResponse,
  MAX_HOOK_BODY_BYTES,
  registerClaudeCodeRoutes,
} from "../../../src/sources/claude-code/index.ts";
import {
  BRIDGE_TOKEN,
  bearer,
  CLI_TOKEN,
  HOST,
  makeApp,
  ORIGIN,
  postJson,
  sessionHeaders,
} from "../../http/helpers.ts";
import { fixedNow, makeSource, T0, useProjects } from "./helpers.ts";

const db = useProjects([{ id: "repo", roots: ["/work/repo"] }]);
const URL = `http://127.0.0.1:4807${CLAUDE_CODE_HOOKS_PATH}`;

type Reply = HookIngestResponse & {
  results: { status: string; error?: { code: string } }[];
  error: { code: string };
};
const read = async (res: Response) => (await res.json()) as Reply;

function hook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: "sess-1",
    cwd: "/work/repo/src",
    hook_event_name: "PreToolUse",
    ...overrides,
  };
}

function setup(extra: Parameters<typeof makeSource>[1] = {}) {
  const { app, pairing } = makeApp();
  const { source, mapper } = makeSource(db(), extra);
  registerClaudeCodeRoutes(app, source);
  return { app, pairing, mapper };
}

function storedEvents(projectId: string) {
  return [...db().events(projectId, 1)];
}

describe("POST /v1/sources/claude-code/hooks", () => {
  it("maps a hook with the CLI token and ingests it into the project its cwd resolves to", async () => {
    const { app, mapper } = setup();
    const res = await app.request(
      URL,
      postJson({ sourceEventId: "u-1", payload: hook() }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(200);
    const body = await read(res);
    expect(body).toEqual({
      projectId: "repo",
      results: [expect.objectContaining({ sourceEventId: "u-1:0", status: "accepted" })],
      heads: { repo: 2 },
    });
    expect(mapper.calls).toEqual([
      { projectId: "repo", sourceEventId: "u-1", receivedAt: T0, late: false },
    ]);
    const [event] = storedEvents("repo");
    expect(event).toMatchObject({
      projectId: "repo",
      sourceId: CLAUDE_CODE_SOURCE_ID,
      sourceEventId: "u-1:0",
      late: false,
    });
  });

  it("sends a hook whose cwd matches no root to Unsorted", async () => {
    const { app } = setup();
    const res = await app.request(
      URL,
      postJson(
        { sourceEventId: "u-2", payload: hook({ cwd: "/work/repo-evil" }) },
        bearer(CLI_TOKEN),
      ),
    );
    expect(res.status).toBe(200);
    expect((await read(res)).projectId).toBe("unsorted");
    expect(storedEvents("unsorted")).toHaveLength(1);
    expect(storedEvents("repo")).toHaveLength(0);
  });

  it("deduplicates a retried hook by its sourceEventId", async () => {
    const { app } = setup();
    const body = { sourceEventId: "u-3", payload: hook() };
    await app.request(URL, postJson(body, bearer(CLI_TOKEN)));
    const again = await app.request(URL, postJson(body, bearer(CLI_TOKEN)));
    expect((await read(again)).results[0]?.status).toBe("duplicate");
    expect(storedEvents("repo")).toHaveLength(1);
  });

  it("assigns projectId, sourceId and late itself, whatever the mapper wrote", async () => {
    const { app } = setup({
      mapper: () => ({
        events: [
          {
            schemaVersion: 1,
            projectId: "unsorted",
            sourceId: "taskville:engine",
            sourceEventId: "x-1",
            occurredAt: T0,
            type: "agent.connected",
            agentId: "a",
            payload: {},
            provenance: "live",
            late: true,
          },
        ],
      }),
    });
    const res = await app.request(
      URL,
      postJson({ sourceEventId: "u-4", payload: hook() }, bearer(CLI_TOKEN)),
    );
    expect((await read(res)).results[0]?.status).toBe("accepted");
    expect(storedEvents("repo")[0]).toMatchObject({
      projectId: "repo",
      sourceId: CLAUDE_CODE_SOURCE_ID,
      late: false,
    });
  });

  it("still runs mapped events through the ingest pipeline's checks", async () => {
    const { app } = setup({
      mapper: () => ({
        events: [
          {
            schemaVersion: 1,
            sourceEventId: "x-2",
            occurredAt: T0,
            type: "request.resolved",
            payload: { requestId: "r", resolution: "answered_here" },
            provenance: "live",
          },
          "not an event",
        ],
      }),
    });
    const res = await app.request(
      URL,
      postJson({ sourceEventId: "u-5", payload: hook() }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(200);
    const { results } = await read(res);
    expect(results.map((r) => r.status)).toEqual(["rejected", "rejected"]);
    expect(results[0]?.error?.code).toBe("engine_only_type");
    expect(storedEvents("repo")).toHaveLength(0);
  });

  it("answers 200 with ignored: true and stores nothing when the mapper ignores the hook", async () => {
    const { app } = setup();
    const res = await app.request(
      URL,
      postJson(
        { sourceEventId: "u-6", payload: hook({ hook_event_name: "Ignored" }) },
        bearer(CLI_TOKEN),
      ),
    );
    expect(res.status).toBe(200);
    expect(await read(res)).toEqual({ projectId: "repo", results: [], heads: {}, ignored: true });
  });

  it("hands mapped evidence to the evidence sink with the resolved project, after ingest", async () => {
    const stored: {
      projectId: string;
      evidence: readonly HookEvidence[];
      head: number | undefined;
    }[] = [];
    const { app } = setup({
      evidence: {
        store: (projectId, evidence) =>
          stored.push({ projectId, evidence, head: db().head(projectId) }),
      },
    });
    await app.request(
      URL,
      postJson(
        {
          sourceEventId: "u-7",
          payload: hook({ tool_use_id: "tu-1", tool_input: { a: 1 }, tool_response: "out" }),
        },
        bearer(CLI_TOKEN),
      ),
    );
    expect(stored).toEqual([
      {
        projectId: "repo",
        evidence: [{ toolCallId: "tu-1", input: { a: 1 }, output: "out" }],
        head: 2,
      },
    ]);
  });

  it("keeps the ingested events when the evidence sink throws, and logs no request content", async () => {
    const logLines: string[] = [];
    const { app } = setup({
      logger: pino({ level: "debug" }, { write: (line: string) => logLines.push(line) }),
      evidence: {
        store: () => {
          throw new Error("secret-ish /work/repo/src");
        },
      },
    });
    const res = await app.request(
      URL,
      postJson({ sourceEventId: "u-8", payload: hook({ tool_use_id: "tu-2" }) }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(200);
    expect(storedEvents("repo")).toHaveLength(1);
    expect(logLines.join("\n")).toContain("evidence store failed");
    expect(logLines.join("\n")).not.toContain("/work/repo");
  });

  it("refuses a browser session and the bridge token", async () => {
    const { app, pairing } = setup();
    const session = pairing.exchange(pairing.issueCode()) ?? "";
    for (const headers of [{ ...sessionHeaders(session), Origin: ORIGIN }, bearer(BRIDGE_TOKEN)]) {
      const res = await app.request(
        URL,
        postJson({ sourceEventId: "u-9", payload: hook() }, headers),
      );
      expect(res.status).toBe(403);
      expect((await read(res)).error.code).toBe("credential_not_allowed");
    }
    expect(storedEvents("repo")).toHaveLength(0);
  });

  it("refuses no credential, a foreign Host, and a foreign Origin", async () => {
    const { app } = setup();
    const body = { sourceEventId: "u-10", payload: hook() };
    const anonymous = await app.request(URL, postJson(body, { Host: HOST, Origin: ORIGIN }));
    expect(anonymous.status).toBe(401);
    const foreignHost = await app.request(
      URL,
      postJson(body, { ...bearer(CLI_TOKEN), Host: "evil.example:4807" }),
    );
    expect((await read(foreignHost)).error.code).toBe("forbidden_host");
    const foreignOrigin = await app.request(
      URL,
      postJson(body, { ...bearer(CLI_TOKEN), Origin: "http://evil.example" }),
    );
    expect((await read(foreignOrigin)).error.code).toBe("forbidden_origin");
    expect(storedEvents("repo")).toHaveLength(0);
  });

  it("rejects a body that is not { sourceEventId, payload } with 400 bad_request", async () => {
    const { app, mapper } = setup();
    const bad: unknown[] = [
      [],
      null,
      "x",
      { payload: hook() },
      { sourceEventId: "", payload: hook() },
      { sourceEventId: 7, payload: hook() },
      { sourceEventId: "x".repeat(10_000), payload: hook() },
      { sourceEventId: "u", payload: [] },
      { sourceEventId: "u", payload: null },
      { sourceEventId: "u", payload: "hook" },
      // `late` is never accepted over HTTP: only the spool (M2.07) sets it.
      { sourceEventId: "u", payload: hook(), late: true },
      { sourceEventId: "u", payload: hook(), extra: 1 },
    ];
    for (const body of bad) {
      const res = await app.request(URL, postJson(body, bearer(CLI_TOKEN)));
      expect(res.status, JSON.stringify(body)?.slice(0, 60)).toBe(400);
      expect((await read(res)).error.code).toBe("bad_request");
    }
    const notJson = await app.request(URL, {
      method: "POST",
      headers: { ...bearer(CLI_TOKEN), "Content-Type": "application/json" },
      body: "{not json",
    });
    expect(notJson.status).toBe(400);
    expect(mapper.calls).toHaveLength(0);
  });

  it("treats a __proto__ key as data, not as a prototype", async () => {
    const { app } = setup();
    const raw = `{"sourceEventId":"u-11","__proto__":{"late":true}, "payload": {"__proto__": {"cwd": "/work/repo"}, "session_id": "s"}}`;
    const res = await app.request(URL, {
      method: "POST",
      headers: { ...bearer(CLI_TOKEN), "Content-Type": "application/json" },
      body: raw,
    });
    expect(res.status).toBe(400);
    const inPayload = `{"sourceEventId":"u-12","payload":{"__proto__":{"cwd":"/work/repo"},"session_id":"s"}}`;
    const res2 = await app.request(URL, {
      method: "POST",
      headers: { ...bearer(CLI_TOKEN), "Content-Type": "application/json" },
      body: inPayload,
    });
    expect(res2.status).toBe(200);
    // An inherited cwd is not the hook's cwd.
    expect((await read(res2)).projectId).toBe("unsorted");
  });

  it("rejects a body over the size limit with 413 payload_too_large before mapping", async () => {
    const { app, mapper } = setup();
    const big = "x".repeat(MAX_HOOK_BODY_BYTES);
    const res = await app.request(
      URL,
      postJson({ sourceEventId: "u-13", payload: hook({ tool_response: big }) }, bearer(CLI_TOKEN)),
    );
    expect(res.status).toBe(413);
    expect((await read(res)).error.code).toBe("payload_too_large");
    expect(mapper.calls).toHaveLength(0);
  });

  it("uses the engine clock for receivedAt", async () => {
    const { app, mapper } = setup({ now: () => new Date(Date.parse("2026-10-31T13:00:00Z")) });
    await app.request(URL, postJson({ sourceEventId: "u-14", payload: hook() }, bearer(CLI_TOKEN)));
    expect(mapper.calls[0]?.receivedAt).toBe("2026-10-31T13:00:00.000Z");
    expect(fixedNow().toISOString()).toBe(T0);
  });
});

describe("ClaudeCodeSource.ingestHook (the spool's entry point)", () => {
  it("passes late: true through to the mapper and the stored events", async () => {
    const { source, mapper } = makeSource(db());
    const response = await source.ingestHook({
      sourceEventId: "s-1",
      payload: hook(),
      late: true,
    });
    expect(response.projectId).toBe("repo");
    expect(mapper.calls[0]?.late).toBe(true);
    expect(storedEvents("repo")[0]?.late).toBe(true);
  });

  it("defaults late to false", async () => {
    const { source } = makeSource(db());
    await source.ingestHook({ sourceEventId: "s-2", payload: hook() });
    expect(storedEvents("repo")[0]?.late).toBe(false);
  });

  it("resolves against projects added after the source was built", async () => {
    const { source } = makeSource(db());
    const { createProject } = await import("../../../src/projects/index.ts");
    createProject(db(), { id: "late-add", name: "late-add", roots: ["/work/new"] });
    const response = await source.ingestHook({
      sourceEventId: "s-3",
      payload: hook({ cwd: "/work/new/x" }),
    });
    expect(response.projectId).toBe("late-add");
  });
});
