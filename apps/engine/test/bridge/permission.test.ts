import { afterEach, describe, expect, it } from "vitest";
import type { Engine } from "../../src/stream/index.ts";
import { bootInProcess } from "../stream/helpers.ts";
import {
  ALLOW_BODY,
  type BridgeHarness,
  bootBridge,
  denyBody,
  eventsOf,
  fakeGithubToken,
  HOLD_MS,
  heldRequestId,
  permissionHook,
  postPermission,
  projectState,
  requestsOf,
  SESSION,
  useDbPath,
} from "./helpers.ts";

const dbPath = useDbPath();
let harness: BridgeHarness | undefined;
afterEach(() => {
  harness?.bridge.close();
  harness?.engine.close();
  harness = undefined;
});

function boot(options: Parameters<typeof bootBridge>[1] = {}): BridgeHarness {
  harness = bootBridge(dbPath(), options);
  return harness;
}

async function expectEmpty2xx(res: Response): Promise<void> {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  expect(await res.text()).toBe("");
}

describe("POST /v1/bridge/claude-code/permission - decided within the hold window", () => {
  it("records an answerable, bridge-held request and answers allow with the exact hook JSON", async () => {
    const { app, engine, bridge, connectViewer, seen } = boot();
    connectViewer();

    const pending = postPermission(app, permissionHook());
    const requestId = await heldRequestId(engine);

    // The request went through the normal commit path: stored, projected, and broadcast.
    const opened = eventsOf(engine, "request.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      sourceId: "taskville:bridge",
      sessionId: SESSION,
      agentId: `claude-code:${SESSION}`,
      payload: { requestId, kind: "permission", toolName: "Bash" },
    });
    expect(seen.map((event) => event.type)).toContain("request.opened");
    const [request] = requestsOf(engine);
    expect(request).toMatchObject({ id: requestId, answerable: true, state: "open" });

    expect(bridge.decide(requestId, { behavior: "allow" })).toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(ALLOW_BODY);
  });

  it("answers deny with the user's message", async () => {
    const { app, engine, bridge, connectViewer } = boot();
    connectViewer();

    const pending = postPermission(app, permissionHook());
    const requestId = await heldRequestId(engine);
    const message = "The owner said no, do not retry";

    expect(bridge.decide(requestId, { behavior: "deny", message })).toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual(denyBody(message));
  });

  it("reports whether a decision reached a still-open response", async () => {
    const { app, engine, bridge, connectViewer } = boot();
    connectViewer();

    const pending = postPermission(app, permissionHook());
    const requestId = await heldRequestId(engine);

    expect(bridge.decide("claude-code:request:unknown", { behavior: "allow" })).toBe(false);
    expect(bridge.decide(requestId, { behavior: "allow" })).toBe(true);
    // The response is already answered: a second decision reaches nothing.
    expect(bridge.decide(requestId, { behavior: "deny", message: "too late" })).toBe(false);
    expect(await (await pending).json()).toEqual(ALLOW_BODY);
  });

  it("does not record a terminal outcome for a response the city already answered", async () => {
    const { app, engine, bridge, connectViewer } = boot();
    connectViewer();

    const pending = postPermission(app, permissionHook());
    const requestId = await heldRequestId(engine);
    bridge.decide(requestId, { behavior: "allow" });
    await pending;
    // Claude Code closes the connection after it reads the answer. That is not a terminal deny.
    await new Promise((resolve) => setTimeout(resolve, 50));

    const terminal = eventsOf(engine, "request.resolved").filter(
      (event) => (event.payload as { decision?: string }).decision === "deny",
    );
    expect(terminal).toEqual([]);
    expect(eventsOf(engine, "request.expired")).toEqual([]);
  });
});

describe("hold window", () => {
  it("defaults to 90 seconds and is configurable in milliseconds", async () => {
    const first = boot();
    first.connectViewer();
    const pending = postPermission(first.app, permissionHook());
    await heldRequestId(first.engine);
    expect(first.scheduler.delays).toContain(HOLD_MS);
    first.scheduler.advance(HOLD_MS);
    await expectEmpty2xx(await pending);
    first.bridge.close();
    first.engine.close();
    harness = undefined;

    const second = bootBridge(`${dbPath()}-2`, { holdWindowMs: 12_000 });
    harness = second;
    second.connectViewer();
    const again = postPermission(second.app, permissionHook());
    await heldRequestId(second.engine);
    expect(second.scheduler.delays).toContain(12_000);
    expect(second.scheduler.delays).not.toContain(HOLD_MS);
    second.scheduler.advance(12_000);
    await expectEmpty2xx(await again);
  });

  it("does not depend on whether a viewer is focused: a connected viewer is enough", async () => {
    const { app, engine, bridge, connectViewer, scheduler } = boot();
    connectViewer();
    const pending = postPermission(app, permissionHook());
    const requestId = await heldRequestId(engine);

    // Well inside the window, still held.
    scheduler.advance(HOLD_MS - 1);
    expect(bridge.lookup(requestId)).toBeDefined();
    expect(bridge.decide(requestId, { behavior: "allow" })).toBe(true);
    expect(await (await pending).json()).toEqual(ALLOW_BODY);
  });
});

describe("timeout and no viewer", () => {
  it("falls through with an empty 2xx when nobody answers within the window", async () => {
    const { app, engine, bridge, connectViewer, scheduler } = boot();
    connectViewer();

    const pending = postPermission(app, permissionHook());
    const requestId = await heldRequestId(engine);
    scheduler.advance(HOLD_MS);

    await expectEmpty2xx(await pending);
    // The hook response is gone, so a later decision reaches nothing.
    expect(bridge.decide(requestId, { behavior: "allow" })).toBe(false);
  });

  it("drops the exact input and stays unanswerable after the fall-through (decision #271 D2)", async () => {
    const { app, engine, bridge, connectViewer, scheduler } = boot();
    connectViewer();

    const pending = postPermission(app, permissionHook());
    const requestId = await heldRequestId(engine);
    expect(bridge.lookup(requestId)).toBeDefined();
    scheduler.advance(HOLD_MS);
    await expectEmpty2xx(await pending);

    expect(bridge.lookup(requestId)).toBeUndefined();
    expect(bridge.decide(requestId, { behavior: "allow" })).toBe(false);
    expect(bridge.decide(requestId, { behavior: "deny", message: "too late" })).toBe(false);
    // D1 default: the request stays open (it expires at the next engine start), unresolved.
    expect(projectState(engine).requests[requestId]?.state).toBe("open");
    expect(eventsOf(engine, "request.resolved")).toEqual([]);
  });

  it("returns an empty 2xx at once when no viewer is connected", async () => {
    const { app, engine, bridge, scheduler } = boot();

    const res = await postPermission(app, permissionHook());

    await expectEmpty2xx(res);
    // Nothing is held: no timer was needed, and no answerable request is left open.
    expect(scheduler.pending).toBe(0);
    expect(requestsOf(engine).filter((r) => r.answerable && r.state === "open")).toEqual([]);
    expect(bridge.lookup("anything")).toBeUndefined();
  });

  it("stops holding once the last viewer has left", async () => {
    const { app, engine, connectViewer } = boot();
    const disconnect = connectViewer();
    disconnect();

    await expectEmpty2xx(await postPermission(app, permissionHook()));
    expect(requestsOf(engine).filter((r) => r.answerable && r.state === "open")).toEqual([]);
  });
});

describe("engine restart", () => {
  it("expires a still-open bridge request at the next start, without the bridge recording anything on shutdown", async () => {
    const first = boot();
    first.connectViewer();
    const pending = postPermission(first.app, permissionHook());
    const requestId = await heldRequestId(first.engine);
    const headBefore = first.engine.storage.head("demo");

    // Shutdown releases the held response but writes no outcome: a missing outcome is what
    // the engine start rule turns into `request.expired`.
    first.bridge.close();
    await pending;
    expect(first.engine.storage.head("demo")).toBe(headBefore);
    expect(projectState(first.engine).requests[requestId]?.state).toBe("open");
    first.engine.close();
    harness = undefined;

    const second = bootInProcess(dbPath());
    const engine: Engine = second.engine;
    try {
      expect(engine.expired).toEqual([{ projectId: "demo", requestId }]);
      expect(projectState(engine).requests[requestId]?.state).toBe("expired");
      expect(eventsOf(engine, "request.expired")).toHaveLength(1);
    } finally {
      engine.close();
    }
  });
});

describe("exact input in memory, redacted copy in events", () => {
  it("keeps the exact tool input only in the held request and stores a masked preview", async () => {
    const { app, engine, bridge, connectViewer } = boot();
    connectViewer();
    const secret = fakeGithubToken();
    const toolInput = {
      command: `git push https://x:${secret}@github.com/owner/repo.git main`,
      description: "Push the branch",
    };

    const pending = postPermission(app, permissionHook({ tool_input: toolInput }));
    const requestId = await heldRequestId(engine);

    // In memory: the exact input, for the decision card.
    const held = bridge.lookup(requestId);
    expect(held).toMatchObject({
      requestId,
      projectId: "demo",
      sessionId: SESSION,
      toolName: "Bash",
    });
    expect(held?.toolInput).toEqual(toolInput);

    // In the log, the projection, and the broadcast: the redacted copy only.
    const everything = JSON.stringify({
      events: eventsOf(engine),
      state: projectState(engine),
    });
    expect(everything).not.toContain(secret);
    const [request] = requestsOf(engine);
    expect(request?.inputPreview).toContain("[REDACTED:");
    expect(request?.inputPreview).toContain("git push");

    bridge.decide(requestId, { behavior: "allow" });
    await pending;
  });
});
