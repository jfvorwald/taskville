import { afterEach, describe, expect, it } from "vitest";
import {
  MAX_HELD,
  MAX_HELD_INPUT_BYTES,
  MAX_LOSSY_SESSIONS,
  MAX_TRACKED_REQUESTS,
} from "../../src/bridge/index.ts";
import {
  AGENT,
  BASE,
  BRIDGE_PERMISSION_PATH,
  BRIDGE_TOKEN,
  type BridgeHarness,
  bearer,
  bootBridge,
  bootFailingBridge,
  eventsOf,
  eventually,
  HOLD_MS,
  heldRequestId,
  manualSignal,
  permissionHook,
  postPermission,
  postToolUseHook,
  projectState,
  requestsOf,
  SESSION,
  useDbPath,
  within,
} from "./helpers.ts";

/** The caps decision #271 and the review fixes pin; the "pins the caps" tests tie them to the exports. */
const HELD_CAP = 64;
const INPUT_CAP = 262_144;
const LOSSY_CAP = 1000;

const dbPath = useDbPath();
let harness: BridgeHarness | undefined;
afterEach(() => {
  harness?.bridge.close();
  harness?.engine.close();
  harness = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const resolvedEvents = (h: BridgeHarness) => eventsOf(h.engine, "request.resolved");

async function expectEmpty2xx(res: Response | undefined): Promise<void> {
  expect(res).toBeDefined();
  expect(res?.status).toBeGreaterThanOrEqual(200);
  expect(res?.status).toBeLessThan(300);
  expect(await res?.text()).toBe("");
}

describe("a storage failure while recording an outcome (security S1)", () => {
  it("does not throw out of the abort listener, releases the hold, and records nothing", async () => {
    const h = bootFailingBridge(dbPath());
    harness = h;
    h.connectViewer();
    const hook = manualSignal();
    const pending = h.bridge.handle(permissionHook(), hook.signal);
    const requestId = await heldRequestId(h.engine);

    h.state.fail = true;
    // Node reports a throwing abort listener as an uncaught exception: it must not throw.
    expect(() => hook.abort()).not.toThrow();
    h.state.fail = false;

    expect(h.bridge.lookup(requestId)).toBeUndefined();
    expect(h.scheduler.pending).toBe(0);
    await expectEmpty2xx(await within(pending));
    expect(resolvedEvents(h)).toEqual([]);
    expect(h.bridge.decide(requestId, { behavior: "allow" })).toBe(false);
  });

  it("does not throw out of observeHook when the commit throws", async () => {
    const h = bootFailingBridge(dbPath());
    harness = h;
    h.connectViewer();
    const pending = h.bridge.handle(permissionHook(), new AbortController().signal);
    await heldRequestId(h.engine);

    h.state.fail = true;
    expect(() => h.bridge.observeHook(postToolUseHook())).not.toThrow();
    h.state.fail = false;

    expect(resolvedEvents(h)).toEqual([]);
    h.bridge.close();
    await expectEmpty2xx(await within(pending));
  });
});

describe("a terminal Yes after the hold fell through (decision #116 D3, decision #271)", () => {
  it("records answered_elsewhere with decision allow for a PostToolUse after the hold window", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    h.connectViewer();
    const pending = postPermission(h.app, permissionHook());
    const requestId = await heldRequestId(h.engine);
    h.scheduler.advance(HOLD_MS);
    await expectEmpty2xx(await pending);
    expect(resolvedEvents(h)).toEqual([]);

    h.bridge.observeHook(postToolUseHook());

    const [resolved] = await eventually(() => {
      const events = resolvedEvents(h);
      expect(events).toHaveLength(1);
      return events;
    });
    expect(resolved).toMatchObject({
      sessionId: SESSION,
      agentId: AGENT,
      payload: { requestId, resolution: "answered_elsewhere", decision: "allow" },
    });
    expect(projectState(h.engine).requests[requestId]?.state).toBe("answered_elsewhere");
  });

  it("closes nothing more for a PostToolUse after the city decided", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    h.connectViewer();
    const pending = postPermission(h.app, permissionHook());
    const requestId = await heldRequestId(h.engine);
    expect(h.bridge.decide(requestId, { behavior: "allow" })).toBe(true);
    await pending;

    h.bridge.observeHook(postToolUseHook());
    await sleep(30);

    expect(resolvedEvents(h)).toEqual([]);
    expect(projectState(h.engine).requests[requestId]?.state).toBe("open");
  });

  it("records allow for a matching PostToolUse of a request that was never held (no viewer)", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    const res = await h.bridge.handle(permissionHook(), new AbortController().signal);
    await expectEmpty2xx(res);
    const [request] = requestsOf(h.engine);
    expect(request).toMatchObject({ answerable: false, state: "open" });

    h.bridge.observeHook(postToolUseHook());

    const [resolved] = await eventually(() => {
      const events = resolvedEvents(h);
      expect(events).toHaveLength(1);
      return events;
    });
    expect(resolved?.payload).toMatchObject({
      requestId: request?.id,
      resolution: "answered_elsewhere",
      decision: "allow",
    });
  });

  it("records nothing when the other identical request is already closed (ambiguous pair)", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    h.connectViewer();
    const first = h.bridge.handle(permissionHook(), new AbortController().signal);
    const firstId = await heldRequestId(h.engine);
    const second = h.bridge.handle(permissionHook(), new AbortController().signal);
    await eventually(() => {
      expect(requestsOf(h.engine).filter((r) => r.answerable && r.state === "open")).toHaveLength(
        2,
      );
    });
    expect(h.bridge.decide(firstId, { behavior: "allow" })).toBe(true);
    await first;

    // Two identical requests were made, one is closed: the PostToolUse could belong to either.
    h.bridge.observeHook(postToolUseHook());
    await sleep(30);

    expect(resolvedEvents(h)).toEqual([]);
    h.bridge.close();
    await second;
  });
});

describe("after the bridge is closed (engine shutdown)", () => {
  it("records nothing for a PostToolUse", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    h.connectViewer();
    const pending = postPermission(h.app, permissionHook());
    await heldRequestId(h.engine);
    h.bridge.close();
    await pending;
    const headBefore = h.engine.storage.head("demo");

    h.bridge.observeHook(postToolUseHook());
    await sleep(30);

    expect(resolvedEvents(h)).toEqual([]);
    expect(h.engine.storage.head("demo")).toBe(headBefore);
  });
});

describe("eviction never drops a held request (roborev N3)", () => {
  /** Enough unheld requests that the bridge forgets its oldest tracked request. */
  async function overflowTracking(h: BridgeHarness, disconnect: () => void): Promise<void> {
    disconnect();
    for (let i = 0; i < MAX_TRACKED_REQUESTS; i++) {
      const res = await h.bridge.handle(
        permissionHook({ tool_input: { command: `echo ${i}` } }),
        new AbortController().signal,
      );
      expect(res?.status).toBe(200);
    }
  }

  it("still lets the city decide a held request after more than the tracking cap arrived", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    const disconnect = h.connectViewer();
    const pending = h.bridge.handle(permissionHook(), new AbortController().signal);
    const requestId = await heldRequestId(h.engine);

    await overflowTracking(h, disconnect);

    expect(h.bridge.lookup(requestId)).toBeDefined();
    expect(h.bridge.decide(requestId, { behavior: "allow" })).toBe(true);
    expect((await pending)?.status).toBe(200);
  }, 30_000);

  it("still records a terminal deny when the connection of that held request closes", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    const disconnect = h.connectViewer();
    const abort = new AbortController();
    const pending = h.bridge.handle(permissionHook(), abort.signal);
    const requestId = await heldRequestId(h.engine);

    await overflowTracking(h, disconnect);
    abort.abort();
    await pending;

    const [resolved] = await eventually(() => {
      const events = resolvedEvents(h);
      expect(events).toHaveLength(1);
      return events;
    });
    expect(resolved?.payload).toMatchObject({
      requestId,
      resolution: "answered_elsewhere",
      decision: "deny",
    });
  }, 30_000);
});

describe("lossy sessions are bounded (roborev N2)", () => {
  it("pins the cap", () => {
    expect(MAX_LOSSY_SESSIONS).toBe(LOSSY_CAP);
  });

  it("keeps the set of sessions that lost a request at or under the cap", async () => {
    // Commits are stubbed: thousands of real appends (and distinct sessions) take a minute.
    const h = bootFailingBridge(dbPath());
    harness = h;
    h.state.stub = true;

    // One session per request: once the tracking cap is full, each new request forgets one
    // session's request, so this drives well past MAX_LOSSY_SESSIONS lossy sessions.
    const total = MAX_TRACKED_REQUESTS + LOSSY_CAP + 100;
    for (let i = 0; i < total; i++) {
      const res = await h.bridge.handle(
        permissionHook({ session_id: `session-${i}` }),
        new AbortController().signal,
      );
      expect(res?.status).toBe(200);
    }

    const stats = h.bridge.stats();
    expect(stats.tracked).toBe(MAX_TRACKED_REQUESTS);
    expect(stats.held).toBe(0);
    expect(stats.lossySessions).toBeGreaterThan(0);
    expect(stats.lossySessions).toBeLessThanOrEqual(LOSSY_CAP);
  }, 120_000);
});

describe("resource caps on held responses (roborev M1)", () => {
  it("pins the caps", () => {
    expect(MAX_HELD).toBe(HELD_CAP);
    expect(MAX_HELD_INPUT_BYTES).toBe(INPUT_CAP);
  });

  /** A Bash input whose `JSON.stringify` is exactly `bytes` long (ASCII only). */
  const inputOfBytes = (bytes: number) => ({
    command: "x".repeat(bytes - JSON.stringify({ command: "" }).length),
  });

  it("holds an input of exactly INPUT_CAP serialized", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    h.connectViewer();
    const toolInput = inputOfBytes(INPUT_CAP);
    expect(JSON.stringify(toolInput).length).toBe(INPUT_CAP);

    const pending = h.bridge.handle(
      permissionHook({ tool_input: toolInput }),
      new AbortController().signal,
    );
    const requestId = await heldRequestId(h.engine);

    expect(h.bridge.lookup(requestId)?.toolInput).toEqual(toolInput);
    h.bridge.close();
    await pending;
  });

  it("records an input over INPUT_CAP as unheld, answers at once, and keeps no input", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    h.connectViewer();

    const res = await within(
      postPermission(h.app, permissionHook({ tool_input: inputOfBytes(INPUT_CAP + 1) })),
    );

    await expectEmpty2xx(res);
    const opened = eventsOf(h.engine, "request.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]?.sourceId).toBe("taskville:bridge-unheld");
    const [request] = requestsOf(h.engine);
    expect(request).toMatchObject({ answerable: false, state: "open" });
    expect(h.scheduler.pending).toBe(0);
    expect(h.bridge.lookup(request?.id ?? "missing")).toBeUndefined();
  });

  it("records a request arriving with HELD_CAP responses already held as unheld, and holds again once one is freed", async () => {
    let n = 0;
    const h = bootBridge(dbPath(), { newRequestId: () => `bridge:request:cap-${n++}` });
    harness = h;
    h.connectViewer();

    const pending: Promise<Response | undefined>[] = [];
    for (let i = 0; i < HELD_CAP; i++) {
      pending.push(
        h.bridge.handle(
          permissionHook({ tool_input: { command: `echo ${i}` } }),
          new AbortController().signal,
        ),
      );
      await eventually(() => expect(h.bridge.lookup(`bridge:request:cap-${i}`)).toBeDefined());
    }

    const overflowId = `bridge:request:cap-${HELD_CAP}`;
    const overflow = await within(
      h.bridge.handle(
        permissionHook({ tool_input: { command: "echo overflow" } }),
        new AbortController().signal,
      ),
    );

    await expectEmpty2xx(overflow);
    const opened = eventsOf(h.engine, "request.opened").find(
      (event) => (event.payload as { requestId?: string }).requestId === overflowId,
    );
    expect(opened?.sourceId).toBe("taskville:bridge-unheld");
    expect(h.bridge.lookup(overflowId)).toBeUndefined();
    expect(h.bridge.decide(overflowId, { behavior: "allow" })).toBe(false);

    // Freeing one slot lets the next request be held again.
    expect(h.bridge.decide("bridge:request:cap-0", { behavior: "allow" })).toBe(true);
    const next = h.bridge.handle(
      permissionHook({ tool_input: { command: "echo after" } }),
      new AbortController().signal,
    );
    await eventually(() =>
      expect(h.bridge.lookup(`bridge:request:cap-${HELD_CAP + 1}`)).toBeDefined(),
    );

    h.bridge.close();
    await Promise.all([...pending, next]);
  }, 30_000);

  it("answers 413 payload_too_large for a body over 1 MiB, opening nothing", async () => {
    const h = bootBridge(dbPath());
    harness = h;
    h.connectViewer();
    const headBefore = h.engine.storage.head("demo");

    const res = await within(
      Promise.resolve(
        h.app.request(`${BASE}${BRIDGE_PERMISSION_PATH}`, {
          method: "POST",
          headers: { ...bearer(BRIDGE_TOKEN), "Content-Type": "application/json" },
          body: JSON.stringify(
            permissionHook({ tool_input: { command: "x".repeat(1.5 * 1024 * 1024) } }),
          ),
        }),
      ),
    );

    expect(res.status).toBe(413);
    expect(await res.json()).toMatchObject({ error: { code: "payload_too_large" } });
    expect(h.engine.storage.head("demo")).toBe(headBefore);
  });
});
