import { createServer } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PairingStore } from "../../src/auth/pairing.ts";
import { createApp } from "../../src/http/app.ts";
import { type RunningServer, startServer } from "../../src/http/server.ts";
import { bootEngine, type Engine } from "../../src/stream/index.ts";
import { CLI_TOKEN } from "../http/helpers.ts";
import { input } from "../stream/helpers.ts";
import {
  AGENT,
  BRIDGE_PERMISSION_PATH,
  BRIDGE_TOKEN,
  type BridgeHarness,
  bootBridge,
  eventsOf,
  eventually,
  heldRequestId,
  permissionHook,
  postPermission,
  postToolUseHook,
  projectState,
  requestsOf,
  SESSION,
  useDbPath,
  wireBridge,
} from "./helpers.ts";

const dbPath = useDbPath();
let harness: BridgeHarness | undefined;
let server: RunningServer | undefined;
afterEach(async () => {
  harness?.bridge.close();
  harness?.engine.close();
  await server?.close();
  harness = undefined;
  server = undefined;
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.once("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => resolve(typeof address === "object" && address ? address.port : 0));
    });
  });
}

function resolvedEvents(engine: Engine) {
  return eventsOf(engine, "request.resolved");
}

describe("the hook connection closes before any city answer (decision #116 D2)", () => {
  it("records a terminal deny: answered_elsewhere with decision deny", async () => {
    // A real socket: only a real connection can be closed by the client.
    const port = await freePort();
    const pairing = new PairingStore();
    const app = createApp({
      port,
      cliToken: CLI_TOKEN,
      bridgeToken: BRIDGE_TOKEN,
      pairing,
      logger: pino({ level: "silent" }),
    });
    const engine = bootEngine({ app, dbPath: dbPath(), pairing, heartbeatMs: 60_000 });
    harness = wireBridge(app, engine);
    server = await startServer({ app, port });
    harness.connectViewer();

    const abort = new AbortController();
    const sent = fetch(`http://127.0.0.1:${port}${BRIDGE_PERMISSION_PATH}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${BRIDGE_TOKEN}`, "Content-Type": "application/json" },
      body: JSON.stringify(permissionHook()),
      signal: abort.signal,
    }).catch(() => undefined);
    const requestId = await heldRequestId(engine);

    // Claude Code closes the connection when the user answers No in the terminal (S-1 exp7).
    abort.abort();
    await sent;

    const [resolved] = await eventually(() => {
      const events = resolvedEvents(engine);
      expect(events).toHaveLength(1);
      return events;
    });
    expect(resolved).toMatchObject({
      sessionId: SESSION,
      agentId: AGENT,
      payload: { requestId, resolution: "answered_elsewhere", decision: "deny" },
    });
    expect(resolved?.sourceId).toMatch(/^taskville:/);
    expect(projectState(engine).requests[requestId]?.state).toBe("answered_elsewhere");
    // The hold timer is cancelled, and a late city decision reaches nothing.
    expect(harness.scheduler.pending).toBe(0);
    expect(harness.bridge.decide(requestId, { behavior: "allow" })).toBe(false);
  });
});

describe("a matching PostToolUse after a terminal Yes (decision #116 D3)", () => {
  it("records a terminal allow and releases the hook with an empty 2xx", async () => {
    harness = bootBridge(dbPath());
    const { app, engine, bridge, connectViewer, scheduler } = harness;
    connectViewer();

    const pending = postPermission(app, permissionHook());
    const requestId = await heldRequestId(engine);

    bridge.observeHook(postToolUseHook());

    const [resolved] = await eventually(() => {
      const events = resolvedEvents(engine);
      expect(events).toHaveLength(1);
      return events;
    });
    expect(resolved).toMatchObject({
      payload: { requestId, resolution: "answered_elsewhere", decision: "allow" },
    });
    expect(resolved?.sourceId).toMatch(/^taskville:/);
    expect(projectState(engine).requests[requestId]?.state).toBe("answered_elsewhere");

    // The engine answers its side of the hook before Claude Code's own timeout: empty 2xx.
    const res = await pending;
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(await res.text()).toBe("");
    expect(scheduler.pending).toBe(0);
    expect(bridge.decide(requestId, { behavior: "allow" })).toBe(false);

    // The same PostToolUse again closes nothing new.
    bridge.observeHook(postToolUseHook());
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(resolvedEvents(engine)).toHaveLength(1);
  });

  it("leaves the request open on unrelated same-session events and on a Notification", async () => {
    harness = bootBridge(dbPath());
    const { app, engine, bridge, connectViewer, scheduler } = harness;
    connectViewer();

    const pending = postPermission(app, permissionHook());
    const requestId = await heldRequestId(engine);
    const headBefore = engine.storage.head("demo");

    // Unrelated telemetry from the same session, through the normal ingest path.
    engine.pipeline.ingest([
      input("u1", {
        type: "tool_call.finished",
        agentId: AGENT,
        sessionId: SESSION,
        sourceId: "claude-code",
        payload: { toolCallId: "toolu_other", phase: "succeeded" },
      }),
      input("u2", {
        type: "session.turn_ended",
        agentId: AGENT,
        sessionId: SESSION,
        sourceId: "claude-code",
        payload: {},
      }),
      input("u3", {
        type: "session.prompt_submitted",
        agentId: AGENT,
        sessionId: SESSION,
        sourceId: "claude-code",
        payload: {},
      }),
    ]);
    // Raw hooks the bridge is told about: none of them matches the held request.
    bridge.observeHook(postToolUseHook({ tool_name: "Edit" }));
    bridge.observeHook(
      postToolUseHook({ tool_input: { command: "touch other.txt", description: "other" } }),
    );
    bridge.observeHook(postToolUseHook({ session_id: "another-session-0000-0000-000000000000" }));
    bridge.observeHook({
      session_id: SESSION,
      cwd: "/tmp/spike-s1/proj",
      prompt_id: "03dc4896-8835-47f5-a515-94a1ad4c675c",
      hook_event_name: "Notification",
      message: "Claude needs your permission",
      notification_type: "permission_prompt",
    });
    bridge.observeHook(postToolUseHook({ hook_event_name: "PreToolUse" }));
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(engine.storage.head("demo")).toBeGreaterThan(headBefore ?? 0);
    expect(projectState(engine).requests[requestId]).toMatchObject({
      state: "open",
      answerable: true,
    });
    expect(resolvedEvents(engine)).toEqual([]);
    // Still held, and still answerable from the city.
    expect(scheduler.pending).toBe(1);
    expect(bridge.decide(requestId, { behavior: "allow" })).toBe(true);
    expect((await pending).status).toBe(200);
  });

  it("does not guess when two held requests match the same PostToolUse", async () => {
    harness = bootBridge(dbPath());
    const { app, engine, bridge, connectViewer } = harness;
    connectViewer();

    const first = postPermission(app, permissionHook());
    await heldRequestId(engine);
    const second = postPermission(app, permissionHook());
    await eventually(() => {
      expect(requestsOf(engine).filter((r) => r.answerable && r.state === "open")).toHaveLength(2);
    });

    bridge.observeHook(postToolUseHook());
    await new Promise((resolve) => setTimeout(resolve, 30));

    expect(resolvedEvents(engine)).toEqual([]);
    expect(requestsOf(engine).filter((r) => r.answerable && r.state === "open")).toHaveLength(2);

    // Release both held responses so the test can end.
    bridge.close();
    await Promise.all([first, second]);
  });
});
