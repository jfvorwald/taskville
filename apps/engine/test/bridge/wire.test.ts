import type { Logger } from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { wirePermissionBridge } from "../../src/bridge/wire.ts";
import type { TaskvilleConfig } from "../../src/config/config.ts";
import { createProject } from "../../src/projects/index.ts";
import { capturingLogger } from "../commands/helpers.ts";
import {
  BRIDGE_TOKEN,
  bearer,
  CLI_TOKEN,
  HOST,
  ORIGIN,
  postJson,
  sessionHeaders,
} from "../http/helpers.ts";
import { fakeGithubToken, fixedNow } from "../ingest/helpers.ts";
import { bootInProcess, input } from "../stream/helpers.ts";
import {
  AGENT,
  ALLOW_BODY,
  BASE,
  CWD,
  denyBody,
  eventsOf,
  heldRequestId,
  ManualScheduler,
  PROJECT,
  permissionHook,
  postPermission,
  postToolUseHook,
  requestsOf,
  SESSION,
  useDbPath,
  within,
} from "./helpers.ts";

// M4.04 (#61): `wirePermissionBridge` is the one place that composes the permission bridge, the
// command service, and the request-input route onto an app. `taskville serve` calls it; the tests
// here call it on an in-process engine so no hold waits 90 seconds.
//
// Pinned API (apps/engine/src/bridge/wire.ts, not re-exported from bridge/index.ts):
//
//   wirePermissionBridge({ app, engine, config, execFile?, schedule?, monotonicNowMs?, now?, logger? })
//     app:    the Hono app from createApp (the routes are registered on it)
//     engine: the booted engine (storage and hub are used)
//     config: Pick<TaskvilleConfig, "bridge" | "sessionOpener">; the hold window is
//             config.bridge.holdWindowSeconds * 1000 ms
//     -> { bridge: PermissionBridge, commands: CommandService, observeHook(payload): void, close(): void }
//   It registers: POST /v1/bridge/claude-code/permission, POST /v1/commands, GET /v1/commands/:id
//   (the real routes, no 501 stub), and GET /v1/requests/:requestId/input.
//   observeHook is bridge.observeHook; close is bridge.close.

const dbPath = useDbPath();
let cleanup: (() => void)[] = [];
afterEach(() => {
  for (const fn of cleanup.splice(0).reverse()) fn();
  cleanup = [];
});

const SECRET_TOKEN = fakeGithubToken();
const SECRET_INPUT = {
  command: `curl -H "Authorization: token ${SECRET_TOKEN}" https://example.test/x`,
  description: "Fetch a thing",
};

function boot(holdWindowSeconds?: number) {
  const { app, engine, pairing } = bootInProcess(dbPath());
  cleanup.push(() => engine.close());
  createProject(engine.storage, { id: PROJECT, name: PROJECT, roots: [CWD] }, { now: fixedNow });
  engine.pipeline.ingest([
    input("agent-1", {
      type: "agent.registered",
      agentId: AGENT,
      sessionId: SESSION,
      sourceId: "claude-code",
      payload: { sourceAgentId: SESSION, displayName: "proj", role: "main", kind: "session" },
    }),
  ]);
  const scheduler = new ManualScheduler();
  const log = capturingLogger();
  const config: Pick<TaskvilleConfig, "bridge" | "sessionOpener"> = {
    bridge: {
      holdWindowSeconds: holdWindowSeconds ?? 90,
      hookTimeoutSeconds: (holdWindowSeconds ?? 90) + 5,
    },
    sessionOpener: null,
  };
  const wired = wirePermissionBridge({
    app,
    engine,
    config,
    schedule: scheduler.schedule,
    logger: log.logger as Logger,
  });
  cleanup.push(() => wired.close());
  const secret = pairing.exchange(pairing.issueCode()) ?? "";
  // A viewer on the project, so the bridge holds hook responses.
  const disconnect = engine.hub.subscribe(PROJECT, { offer: () => {}, end: () => {} });
  cleanup.push(disconnect);
  const asBrowser = (extra: Record<string, string> = {}) => ({
    ...sessionHeaders(secret),
    Origin: ORIGIN,
    ...extra,
  });
  const decide = (requestId: string, decision: unknown, idempotencyKey = "key-1") =>
    Promise.resolve(
      app.request(
        `${BASE}/v1/commands`,
        postJson(
          { type: "permission.decide", projectId: PROJECT, requestId, idempotencyKey, decision },
          asBrowser(),
        ),
      ),
    );
  const inputOf = (
    requestId: string,
    query = `?projectId=${PROJECT}`,
    headers = sessionHeaders(secret),
  ) => Promise.resolve(app.request(`${BASE}/v1/requests/${requestId}/input${query}`, { headers }));
  return { app, engine, wired, scheduler, log, secret, decide, inputOf, asBrowser };
}

describe("wirePermissionBridge: bridge and command routes", () => {
  it("returns the bridge, the command service, observeHook, and close", () => {
    const h = boot();
    expect(typeof h.wired.bridge.handle).toBe("function");
    expect(typeof h.wired.commands.submit).toBe("function");
    expect(typeof h.wired.observeHook).toBe("function");
    expect(typeof h.wired.close).toBe("function");
  });

  it("registers the real command routes: a bad body is 400, not the 501 stub", async () => {
    const h = boot();
    const post = await h.app.request(`${BASE}/v1/commands`, postJson({}, h.asBrowser()));
    expect(post.status).toBe(400);
    expect(((await post.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    const get = await h.app.request(`${BASE}/v1/commands/nope`, { headers: h.asBrowser() });
    expect(get.status).toBe(404);
    expect(((await get.json()) as { error: { code: string } }).error.code).toBe("unknown_command");
  });

  it("an allow from the paired browser reaches the held hook as exactly the hook JSON", async () => {
    const h = boot();
    const hook = postPermission(h.app, permissionHook());
    const requestId = await heldRequestId(h.engine);
    const res = await h.decide(requestId, { behavior: "allow" });
    expect(res.status).toBe(200);
    expect(((await res.json()) as { command: { status: string } }).command.status).toBe(
      "delivered",
    );
    const answered = await within(hook);
    expect(answered.status).toBe(200);
    expect(await answered.text()).toBe(JSON.stringify(ALLOW_BODY));
    expect(eventsOf(h.engine, "request.resolved")).toHaveLength(1);
    expect(eventsOf(h.engine, "command.delivered")).toHaveLength(1);
  });

  it("a deny note reaches the hook with control characters stripped", async () => {
    const h = boot();
    const hook = postPermission(h.app, permissionHook());
    const requestId = await heldRequestId(h.engine);
    const res = await h.decide(requestId, {
      behavior: "deny",
      message: "not\u0007 now\u009f, thanks",
    });
    expect(res.status).toBe(200);
    expect(await (await within(hook)).json()).toEqual(denyBody("not now, thanks"));
  });

  it("a double click (the same idempotency key twice) answers once", async () => {
    const h = boot();
    const hook = postPermission(h.app, permissionHook());
    const requestId = await heldRequestId(h.engine);
    const first = await h.decide(requestId, { behavior: "allow" }, "dbl");
    const second = await h.decide(requestId, { behavior: "allow" }, "dbl");
    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    const a = ((await first.json()) as { command: { id: string } }).command.id;
    const b = ((await second.json()) as { command: { id: string } }).command.id;
    expect(b).toBe(a);
    expect(await (await within(hook)).json()).toEqual(ALLOW_BODY);
    expect(eventsOf(h.engine, "request.resolved")).toHaveLength(1);
    expect(eventsOf(h.engine, "command.requested")).toHaveLength(1);
  });

  it("a command token never answers: the bridge, CLI, and shim tokens get 403", async () => {
    const h = boot();
    const hook = postPermission(h.app, permissionHook());
    const requestId = await heldRequestId(h.engine);
    for (const token of [BRIDGE_TOKEN, CLI_TOKEN]) {
      const res = await h.app.request(
        `${BASE}/v1/commands`,
        postJson(
          {
            type: "permission.decide",
            projectId: PROJECT,
            requestId,
            idempotencyKey: "tok",
            decision: { behavior: "allow" },
          },
          bearer(token),
        ),
      );
      expect(res.status).toBe(403);
    }
    expect(h.wired.bridge.lookup(requestId)).toBeDefined();
    h.wired.close();
    await within(hook);
  });
});

describe("wirePermissionBridge: hold window from config", () => {
  it("holds for bridge.holdWindowSeconds (default 90 s)", async () => {
    const h = boot();
    const hook = postPermission(h.app, permissionHook());
    await heldRequestId(h.engine);
    expect(h.scheduler.delays).toEqual([90_000]);
    h.scheduler.advance(90_000);
    const res = await within(hook);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
  });

  it("uses a configured window, and not a second earlier", async () => {
    const h = boot(120);
    const hook = postPermission(h.app, permissionHook());
    const requestId = await heldRequestId(h.engine);
    expect(h.scheduler.delays).toEqual([120_000]);
    h.scheduler.advance(119_999);
    expect(h.wired.bridge.lookup(requestId)).toBeDefined();
    h.scheduler.advance(1);
    expect(h.wired.bridge.lookup(requestId)).toBeUndefined();
    expect((await within(hook)).status).toBe(200);
  });
});

describe("wirePermissionBridge: close and observeHook", () => {
  it("close() releases every held response with the empty 2xx and writes no outcome", async () => {
    const h = boot();
    const hook = postPermission(h.app, permissionHook());
    await heldRequestId(h.engine);
    const resolvedBefore = eventsOf(h.engine, "request.resolved").length;
    h.wired.close();
    const res = await within(hook);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(eventsOf(h.engine, "request.resolved")).toHaveLength(resolvedBefore);
  });

  it("observeHook(PostToolUse) closes a held request as answered_elsewhere but never allows the hook", async () => {
    const h = boot();
    const hook = postPermission(h.app, permissionHook());
    const requestId = await heldRequestId(h.engine);
    h.wired.observeHook(postToolUseHook());
    const res = await within(hook);
    // The hook is released with the empty 2xx (fall through to Claude Code's own dialog), never
    // with an allow: telemetry is unauthenticated (security review M3).
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    const [resolved] = eventsOf(h.engine, "request.resolved");
    expect(resolved?.payload).toMatchObject({
      requestId,
      resolution: "answered_elsewhere",
      decision: "allow",
    });
    expect(requestsOf(h.engine).find((r) => r.id === requestId)?.state).not.toBe("open");
    // It cannot be decided afterwards.
    const late = await h.decide(requestId, { behavior: "allow" }, "late");
    expect(late.status).toBe(409);
    expect(h.scheduler.pending).toBe(0);
  });

  it("observeHook ignores anything but a matching PostToolUse", async () => {
    const h = boot();
    const hook = postPermission(h.app, permissionHook());
    const requestId = await heldRequestId(h.engine);
    h.wired.observeHook({ ...postToolUseHook(), hook_event_name: "Notification" });
    h.wired.observeHook(postToolUseHook({ tool_input: { command: "rm -rf /" } }));
    h.wired.observeHook("not an object");
    expect(h.wired.bridge.lookup(requestId)).toBeDefined();
    h.wired.close();
    await within(hook);
  });
});

describe("GET /v1/requests/:requestId/input", () => {
  async function held(h: ReturnType<typeof boot>) {
    const hook = postPermission(h.app, permissionHook({ tool_input: SECRET_INPUT }));
    const requestId = await heldRequestId(h.engine);
    return { hook, requestId };
  }

  it("returns the exact, unredacted input of a held request to the paired browser", async () => {
    const h = boot();
    const { requestId } = await held(h);
    const res = await h.inputOf(requestId);
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      requestId,
      projectId: PROJECT,
      sessionId: SESSION,
      toolName: "Bash",
      toolInput: SECRET_INPUT,
      cwd: CWD,
    });
    expect(h.wired.bridge.lookup(requestId)?.cwd).toBe(CWD);
  });

  it("is never cached and never gets CORS headers", async () => {
    const h = boot();
    const { requestId } = await held(h);
    const res = await h.inputOf(requestId);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.get("access-control-allow-origin")).toBeNull();
    const refused = await h.inputOf("bridge:request:nope");
    expect(refused.headers.get("cache-control")).toBe("no-store");
  });

  it("is for a paired browser session only: the CLI, shim, and bridge tokens get 403", async () => {
    const h = boot();
    const { requestId } = await held(h);
    // The shim authenticates with the CLI token.
    for (const token of [CLI_TOKEN, BRIDGE_TOKEN]) {
      const res = await h.inputOf(requestId, `?projectId=${PROJECT}`, bearer(token));
      expect(res.status).toBe(403);
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code: "credential_not_allowed" } });
      expect(body).not.toContain(SECRET_TOKEN);
    }
  });

  it("needs a credential, the loopback Host, and an allowed Origin", async () => {
    const h = boot();
    const { requestId } = await held(h);
    const url = `${BASE}/v1/requests/${requestId}/input?projectId=${PROJECT}`;
    expect((await h.app.request(url, { headers: { Host: HOST } })).status).toBe(401);
    expect(
      (await h.app.request(url, { headers: { ...sessionHeaders(h.secret), Host: "evil.test" } }))
        .status,
    ).toBe(403);
    const origin = await h.app.request(url, {
      headers: { ...sessionHeaders(h.secret), Origin: "http://evil.test" },
    });
    expect(origin.status).toBe(403);
    expect(await origin.text()).not.toContain(SECRET_TOKEN);
  });

  it("is 400 bad_request without a projectId, and 404 unknown_request for another project or an unknown ID", async () => {
    const h = boot();
    const { requestId } = await held(h);
    const missing = await h.inputOf(requestId, "");
    expect(missing.status).toBe(400);
    expect(await missing.json()).toMatchObject({ error: { code: "bad_request" } });
    for (const [id, query] of [
      [requestId, "?projectId=other"],
      ["bridge:request:nope", `?projectId=${PROJECT}`],
    ] as const) {
      const res = await h.inputOf(id, query);
      expect(res.status).toBe(404);
      const body = await res.text();
      expect(JSON.parse(body)).toMatchObject({ error: { code: "unknown_request" } });
      expect(body).not.toContain(SECRET_TOKEN);
    }
  });

  it("is 400 bad_request for an empty projectId, even for a held request", async () => {
    const h = boot();
    const { requestId } = await held(h);
    const res = await h.inputOf(requestId, "?projectId=");
    expect(res.status).toBe(400);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "bad_request" } });
    expect(body).not.toContain(SECRET_TOKEN);
  });

  it("is 410 request_expired once the hold window ended", async () => {
    const h = boot();
    const { requestId } = await held(h);
    h.scheduler.advance(90_000);
    const res = await h.inputOf(requestId);
    expect(res.status).toBe(410);
    const body = await res.text();
    expect(JSON.parse(body)).toMatchObject({ error: { code: "request_expired" } });
    expect(body).not.toContain(SECRET_TOKEN);
  });

  it("is 410 request_expired once the city decided it", async () => {
    const h = boot();
    const { hook, requestId } = await held(h);
    expect((await h.decide(requestId, { behavior: "allow" })).status).toBe(200);
    await within(hook);
    expect((await h.inputOf(requestId)).status).toBe(410);
  });

  it("is 410 request_expired once a matching PostToolUse closed it", async () => {
    const h = boot();
    const { requestId } = await held(h);
    h.wired.observeHook(postToolUseHook({ tool_input: SECRET_INPUT }));
    expect((await h.inputOf(requestId)).status).toBe(410);
  });

  it("never logs the exact input", async () => {
    const h = boot();
    const { requestId } = await held(h);
    await h.inputOf(requestId);
    await h.decide(requestId, { behavior: "allow" });
    expect(h.log.lines.join("\n")).not.toContain(SECRET_TOKEN);
    expect(JSON.stringify(eventsOf(h.engine))).not.toContain(SECRET_TOKEN);
  });
});
