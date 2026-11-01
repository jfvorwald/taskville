import { createServer } from "node:net";
import pino from "pino";
import { afterEach, describe, expect, it } from "vitest";
import { PairingStore } from "../../src/auth/pairing.ts";
import { MAX_TRACKED_REQUESTS } from "../../src/bridge/index.ts";
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
  HOLD_MS,
  heldRequestId,
  permissionHook,
  postPermission,
  postToolUseHook,
  projectState,
  requestsOf,
  SESSION,
  T0,
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

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function answerableOpen(engine: Engine) {
  return requestsOf(engine).filter((r) => r.answerable && r.state === "open");
}

describe("a request the projection merged into another (roborev 5763)", () => {
  it("is never resolved by its own PostToolUse: that would close the held request it merged into", async () => {
    harness = bootBridge(dbPath());
    const { engine, bridge, connectViewer } = harness;

    // A has no viewer, so it is recorded but unheld; B then arrives held, with the same session
    // and tool but a different input, and the projection folds A into B's record.
    const first = await bridge.handle(permissionHook(), new AbortController().signal);
    expect(first?.status).toBe(200);
    connectViewer();
    const other = { command: "touch other.txt", description: "Create other.txt" };
    const pending = bridge.handle(
      permissionHook({ tool_input: other }),
      new AbortController().signal,
    );
    const heldId = await heldRequestId(engine);
    expect(requestsOf(engine)).toHaveLength(1);
    expect(requestsOf(engine)[0]?.mergedRequestIds).toHaveLength(1);

    // The terminal Yes for A's own call: it matches A (and only A).
    bridge.observeHook(postToolUseHook());
    await sleep(30);

    expect(resolvedEvents(engine)).toEqual([]);
    expect(projectState(engine).requests[heldId]).toMatchObject({
      state: "open",
      answerable: true,
    });
    expect(bridge.lookup(heldId)).toBeDefined();
    expect(bridge.decide(heldId, { behavior: "allow" })).toBe(true);
    expect((await pending)?.status).toBe(200);
  });
});

describe("forgetting a tracked request (roborev 5763)", () => {
  it("does not let eviction hide a duplicate: a PostToolUse in that session closes nothing", async () => {
    harness = bootBridge(dbPath());
    const { engine, bridge, connectViewer } = harness;
    const disconnect = connectViewer();

    // Two held requests with identical correlation fields: ambiguous for any PostToolUse.
    const one = bridge.handle(permissionHook(), new AbortController().signal);
    await heldRequestId(engine);
    const two = bridge.handle(permissionHook(), new AbortController().signal);
    await eventually(() => expect(answerableOpen(engine)).toHaveLength(2));
    const heldIds = answerableOpen(engine).map((r) => r.id);

    // Enough other requests that the bridge forgets the oldest of the pair. No viewer is
    // connected, so they are recorded but not held and return at once.
    disconnect();
    for (let i = 0; i < MAX_TRACKED_REQUESTS - 1; i++) {
      const res = await bridge.handle(
        permissionHook({ tool_input: { command: `echo ${i}` } }),
        new AbortController().signal,
      );
      expect(res?.status).toBe(200);
    }

    bridge.observeHook(postToolUseHook());
    await sleep(30);

    // One tracked request is left with that key, but it was one of two: no guess.
    expect(resolvedEvents(engine)).toEqual([]);
    expect(
      answerableOpen(engine)
        .map((r) => r.id)
        .sort(),
    ).toEqual([...heldIds].sort());
    for (const id of heldIds) expect(bridge.lookup(id)).toBeDefined();

    bridge.close();
    await Promise.all([one, two]);
  }, 30_000);
});

describe("a hook connection that closes late (roborev 5774, 5775)", () => {
  /** A controllable monotonic clock and wall clock, both injected into the bridge. */
  function clocks() {
    const state = { mono: 5_000, wall: Date.parse(T0) };
    return {
      state,
      options: {
        monotonicNowMs: () => state.mono,
        now: () => new Date(state.wall),
      },
    };
  }

  /** Opens a held request straight on the bridge, with an abort the test controls. */
  async function holdRequest(h: BridgeHarness) {
    h.connectViewer();
    const abort = new AbortController();
    const pending = h.bridge.handle(permissionHook(), abort.signal);
    const requestId = await heldRequestId(h.engine);
    return { abort, pending, requestId };
  }

  it("records a terminal deny when the close comes while still inside the hold window", async () => {
    const c = clocks();
    harness = bootBridge(dbPath(), c.options);
    const { engine } = harness;
    const { abort, pending, requestId } = await holdRequest(harness);

    c.state.mono += HOLD_MS - 1;
    abort.abort();

    const res = await pending;
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("");
    const [resolved] = await eventually(() => {
      const events = resolvedEvents(engine);
      expect(events).toHaveLength(1);
      return events;
    });
    expect(resolved?.payload).toMatchObject({
      requestId,
      resolution: "answered_elsewhere",
      decision: "deny",
    });
  });

  it("records nothing when the close comes after the hold window although the timer has not fired", async () => {
    const c = clocks();
    harness = bootBridge(dbPath(), c.options);
    const { engine, bridge, scheduler } = harness;
    const { abort, pending, requestId } = await holdRequest(harness);

    // The window has run out on the clock, but a stalled event loop has not run the timer yet.
    c.state.mono += HOLD_MS;
    abort.abort();

    const res = await pending;
    expect(res?.status).toBe(200);
    expect(await res?.text()).toBe("");
    await sleep(30);
    expect(resolvedEvents(engine)).toEqual([]);
    // Left open for the next engine start to expire; nothing can answer it now.
    expect(projectState(engine).requests[requestId]?.state).toBe("open");
    expect(scheduler.pending).toBe(0);
    expect(bridge.lookup(requestId)).toBeUndefined();
    expect(bridge.decide(requestId, { behavior: "allow" })).toBe(false);
  });

  it("records nothing for a close after the timer already released the hold", async () => {
    const c = clocks();
    harness = bootBridge(dbPath(), c.options);
    const { engine, scheduler } = harness;
    const { abort, pending, requestId } = await holdRequest(harness);

    c.state.mono += HOLD_MS;
    scheduler.advance(HOLD_MS);
    expect((await pending)?.status).toBe(200);
    abort.abort();
    await sleep(30);

    expect(resolvedEvents(engine)).toEqual([]);
    expect(projectState(engine).requests[requestId]?.state).toBe("open");
  });

  it("times the hold on a monotonic clock: a wall-clock jump forward does not turn a deny into a timeout", async () => {
    const c = clocks();
    harness = bootBridge(dbPath(), c.options);
    const { engine } = harness;
    const { abort, pending, requestId } = await holdRequest(harness);

    // An hour passes on the wall clock (clock step, resume from sleep); the monotonic clock does not.
    c.state.wall += 3_600_000;
    c.state.mono += 1_000;
    abort.abort();
    await pending;

    const [resolved] = await eventually(() => {
      const events = resolvedEvents(engine);
      expect(events).toHaveLength(1);
      return events;
    });
    expect(resolved?.payload).toMatchObject({ requestId, decision: "deny" });
  });

  it("times the hold on a monotonic clock: a wall-clock jump back does not extend the hold", async () => {
    const c = clocks();
    harness = bootBridge(dbPath(), c.options);
    const { engine } = harness;
    const { abort, pending } = await holdRequest(harness);

    c.state.wall -= 3_600_000;
    c.state.mono += HOLD_MS + 1_000;
    abort.abort();
    await pending;
    await sleep(30);

    expect(resolvedEvents(engine)).toEqual([]);
  });
});
