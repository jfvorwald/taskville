import { afterEach, describe, expect, it } from "vitest";
import { MAX_TRACKED_CODEX_CALLS } from "../../src/bridge/bridge.ts";
import { DEFAULT_CODEX_HOLD_WINDOW_MS } from "../../src/bridge/index.ts";
import { CLI_TOKEN, ORIGIN, sessionHeaders } from "../http/helpers.ts";
import {
  ALLOW_BODY,
  CHILD,
  CODEX_AGENT,
  CODEX_HOLD_MS,
  CODEX_SESSION,
  codexInterrupt,
  codexPermissionHook,
  codexPostToolUse,
  codexPreToolUse,
  denyBody,
  OTHER_TURN,
  postCodexPermission,
  realSchedule,
  registerCodexAgent,
} from "./codex-helpers.ts";
import {
  type BridgeHarness,
  bearer,
  bootBridge,
  eventsOf,
  eventually,
  HOLD_MS,
  heldRequestId,
  projectState,
  requestsOf,
  useDbPath,
  within,
} from "./helpers.ts";

// A1.02 (#507): `POST /v1/bridge/codex/permission` (docs/spikes/S-5-codex.md, Gaps 1, 2, 5).
// While a Codex PermissionRequest hook runs the terminal prompt is hidden, so the hold is short
// (5 s default) and an unanswered hold gives Codex a no-decision answer (empty 2xx) so it shows
// its own prompt. A later PostToolUse closes the request only on one unambiguous match.

const dbPath = useDbPath();
let harness: BridgeHarness | undefined;
afterEach(() => {
  harness?.bridge.close();
  harness?.engine.close();
  harness = undefined;
});

function boot(options: Parameters<typeof bootBridge>[1] = {}, viewer = true): BridgeHarness {
  harness = bootBridge(dbPath(), options);
  registerCodexAgent(harness.engine);
  if (viewer) harness.connectViewer();
  return harness;
}

async function expectNoDecision(res: Response): Promise<void> {
  expect(res.status).toBeGreaterThanOrEqual(200);
  expect(res.status).toBeLessThan(300);
  expect(await res.text()).toBe("");
}

/** Hands a hook to the bridge the way the Codex telemetry route does after it commits it. */
const observe = (h: BridgeHarness, hook: Record<string, unknown>) =>
  (h.bridge as unknown as { observeCodexHook(raw: unknown): void }).observeCodexHook(hook);

const resolved = (h: BridgeHarness) => eventsOf(h.engine, "request.resolved");

describe("POST /v1/bridge/codex/permission - answered by the city", () => {
  it("records an answerable request for the Codex session agent and answers allow", async () => {
    const h = boot();
    const pending = postCodexPermission(h.app, codexPermissionHook());
    const requestId = await heldRequestId(h.engine);

    const opened = eventsOf(h.engine, "request.opened");
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      sourceId: "taskville:bridge",
      sessionId: CODEX_SESSION,
      agentId: CODEX_AGENT,
      payload: { requestId, kind: "permission", toolName: "Bash" },
    });
    expect(requestsOf(h.engine)[0]).toMatchObject({ id: requestId, answerable: true });

    expect(h.bridge.decide(requestId, { behavior: "allow" })).toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toContain("application/json");
    expect(await res.json()).toEqual(ALLOW_BODY);
  });

  it("answers deny with the user's message in the Codex hook JSON", async () => {
    const h = boot();
    const pending = postCodexPermission(h.app, codexPermissionHook());
    const requestId = await heldRequestId(h.engine);
    expect(h.bridge.decide(requestId, { behavior: "deny", message: "Not now" })).toBe(true);
    expect(await (await pending).json()).toEqual(denyBody("Not now"));
  });

  it("attributes a subagent's request to the subagent", async () => {
    const h = boot();
    const pending = postCodexPermission(
      h.app,
      codexPermissionHook({ agent_id: CHILD, agent_type: "default" }),
    );
    const requestId = await heldRequestId(h.engine);
    expect(eventsOf(h.engine, "request.opened")[0]?.agentId).toBe(`${CODEX_AGENT}:${CHILD}`);
    h.bridge.decide(requestId, { behavior: "allow" });
    await pending;
  });
});

describe("hold expiry", () => {
  it("defaults to 5 seconds for Codex while Claude Code keeps 90", async () => {
    expect(DEFAULT_CODEX_HOLD_WINDOW_MS).toBe(CODEX_HOLD_MS);
    const h = boot();
    const pending = postCodexPermission(h.app, codexPermissionHook());
    await heldRequestId(h.engine);
    expect(h.scheduler.delays).toContain(CODEX_HOLD_MS);
    expect(h.scheduler.delays).not.toContain(HOLD_MS);
    h.scheduler.advance(CODEX_HOLD_MS);
    // No decision: Codex shows its own terminal prompt.
    await expectNoDecision(await pending);
  });

  it("is set by codexHoldWindowMs and leaves the Claude Code hold alone", async () => {
    const h = boot({ codexHoldWindowMs: 1_500 });
    const pending = postCodexPermission(h.app, codexPermissionHook());
    await heldRequestId(h.engine);
    expect(h.scheduler.delays).toContain(1_500);
    h.scheduler.advance(1_500);
    await expectNoDecision(await pending);
  });

  it("with a tiny injected hold and real timers, answers no-decision and a late decision reaches nothing", async () => {
    const h = boot({ codexHoldWindowMs: 25, schedule: realSchedule });
    const pending = postCodexPermission(h.app, codexPermissionHook());
    const requestId = await heldRequestId(h.engine);
    await expectNoDecision(await within(pending, 1_000));
    expect(h.bridge.decide(requestId, { behavior: "allow" })).toBe(false);
  });

  it("does not hold when no viewer is connected: no decision at once, request not answerable", async () => {
    const h = boot({}, false);
    await expectNoDecision(await within(postCodexPermission(h.app, codexPermissionHook())));
    expect(requestsOf(h.engine).filter((r) => r.answerable)).toEqual([]);
  });

  it("declares a codex exec session (bypassPermissions) unanswerable: no hold at all", async () => {
    const h = boot();
    const res = await within(
      postCodexPermission(h.app, codexPermissionHook({ permission_mode: "bypassPermissions" })),
    );
    await expectNoDecision(res);
    expect(h.scheduler.pending).toBe(0);
    expect(requestsOf(h.engine).filter((r) => r.answerable)).toEqual([]);
  });
});

describe("credentials and body", () => {
  it("admits the bridge token only: the CLI token and a browser session get 403", async () => {
    const h = boot();
    const cli = await postCodexPermission(h.app, codexPermissionHook(), bearer(CLI_TOKEN));
    expect(cli.status).toBe(403);
    const browser = await postCodexPermission(h.app, codexPermissionHook(), {
      ...sessionHeaders("not-a-session"),
      Origin: ORIGIN,
    });
    expect([401, 403]).toContain(browser.status);
    expect(requestsOf(h.engine)).toEqual([]);
  });

  it("answers 400 for a body that is not a hook object with a session and a tool", async () => {
    const h = boot();
    for (const body of [[], "x", {}, { session_id: CODEX_SESSION }, { tool_name: "Bash" }]) {
      const res = await postCodexPermission(h.app, body);
      expect(res.status, JSON.stringify(body)).toBe(400);
    }
  });
});

describe("a later PostToolUse resolves the request only on one unambiguous match", () => {
  /** Opens a held request after its PreToolUse, as Codex orders them, and returns its id. */
  async function openAfterPre(h: BridgeHarness, hooks: Record<string, unknown>[], request = {}) {
    for (const hook of hooks) observe(h, hook);
    const pending = postCodexPermission(h.app, codexPermissionHook(request));
    const requestId = await heldRequestId(h.engine);
    return { pending, requestId };
  }
  const stateOf = (h: BridgeHarness, id: string) => projectState(h.engine).requests[id]?.state;

  it("closes it as answered_elsewhere with allow when exactly one open call matches", async () => {
    const h = boot();
    const { pending, requestId } = await openAfterPre(h, [codexPreToolUse("call-1")]);
    observe(h, codexPostToolUse("call-1"));

    await expectNoDecision(await within(pending));
    const [event] = resolved(h);
    expect(resolved(h)).toHaveLength(1);
    expect(event).toMatchObject({
      sessionId: CODEX_SESSION,
      agentId: CODEX_AGENT,
      payload: { requestId, resolution: "answered_elsewhere", decision: "allow" },
    });
    expect(stateOf(h, requestId)).toBe("answered_elsewhere");
  });

  it("matches a subagent's call by agent id", async () => {
    const h = boot();
    const sub = { agent_id: CHILD, agent_type: "default" };
    const { pending, requestId } = await openAfterPre(h, [codexPreToolUse("call-s", sub)], sub);
    observe(h, codexPostToolUse("call-s", sub));
    await expectNoDecision(await within(pending));
    expect(stateOf(h, requestId)).toBe("answered_elsewhere");
  });

  it.each([
    ["a different command", { tool_input: { command: "curl -s http://127.0.0.1:1/other" } }],
    ["a different tool", { tool_name: "apply_patch" }],
    ["a different turn", { turn_id: OTHER_TURN }],
    ["a different session", { session_id: "01a1bd20-ffff-7000-8000-00000000ffff" }],
    ["a subagent when the request is the main agent's", { agent_id: CHILD }],
  ])("a PostToolUse from %s never resolves it", async (_name, post) => {
    const h = boot();
    const { pending, requestId } = await openAfterPre(h, [codexPreToolUse("call-1")]);
    // The other call had its own Pre, so a plain Post would be unambiguous for it.
    observe(h, codexPreToolUse("call-x", post));
    observe(h, codexPostToolUse("call-x", post));
    expect(resolved(h)).toEqual([]);
    expect(stateOf(h, requestId)).toBe("open");
    h.scheduler.advance(CODEX_HOLD_MS);
    await expectNoDecision(await pending);
  });

  it("never resolves when two open calls match (parallel identical calls, one request)", async () => {
    const h = boot();
    const { pending, requestId } = await openAfterPre(h, [
      codexPreToolUse("call-1"),
      codexPreToolUse("call-2"),
    ]);
    observe(h, codexPostToolUse("call-1"));
    expect(resolved(h)).toEqual([]);
    expect(stateOf(h, requestId)).toBe("open");
    // The request falls to the normal hold expiry.
    h.scheduler.advance(CODEX_HOLD_MS);
    await expectNoDecision(await pending);
  });

  it("never resolves when two identical requests are open", async () => {
    const h = boot();
    observe(h, codexPreToolUse("call-1"));
    observe(h, codexPreToolUse("call-2"));
    const first = postCodexPermission(h.app, codexPermissionHook());
    await heldRequestId(h.engine);
    const second = postCodexPermission(h.app, codexPermissionHook());
    await eventually(() => {
      expect(requestsOf(h.engine).filter((r) => r.state === "open")).toHaveLength(2);
    });

    observe(h, codexPostToolUse("call-1"));
    expect(resolved(h)).toEqual([]);
    expect(requestsOf(h.engine).every((r) => r.state === "open")).toBe(true);
    h.scheduler.advance(CODEX_HOLD_MS);
    await expectNoDecision(await first);
    await expectNoDecision(await second);
  });

  // roborev 7654 (high): a request closes only when a PreToolUse with the same tool_use_id was
  // tracked (session and correlation key as well). A Post alone proves nothing about which call
  // it ends, and a Post while tracking dropped calls may end one the bridge forgot.
  it("leaves the request open when the PostToolUse has no tracked PreToolUse", async () => {
    const h = boot();
    const { pending, requestId } = await openAfterPre(h, []);
    observe(h, codexPostToolUse("call-1"));
    expect(resolved(h)).toEqual([]);
    expect(stateOf(h, requestId)).toBe("open");
    expect(h.bridge.decide(requestId, { behavior: "allow" })).toBe(true);
    await pending;
  });

  it("leaves the request open when the tracked PreToolUse has another tool_use_id", async () => {
    const h = boot();
    const { pending, requestId } = await openAfterPre(h, [codexPreToolUse("call-1")]);
    observe(h, codexPostToolUse("call-2"));
    expect(resolved(h)).toEqual([]);
    expect(stateOf(h, requestId)).toBe("open");
    h.scheduler.advance(CODEX_HOLD_MS);
    await expectNoDecision(await pending);
  });

  it("leaves the request open while call tracking is lossy (more calls than it keeps)", async () => {
    const h = boot();
    // Distinct calls, each started and never finished, until the bridge has forgotten some.
    for (let i = 0; i <= MAX_TRACKED_CODEX_CALLS; i++) {
      observe(h, codexPreToolUse(`flood-${i}`, { tool_input: { command: `echo ${i}` } }));
    }
    const { pending, requestId } = await openAfterPre(h, [codexPreToolUse("call-1")]);
    observe(h, codexPostToolUse("call-1"));
    expect(resolved(h)).toEqual([]);
    expect(stateOf(h, requestId)).toBe("open");
    h.scheduler.advance(CODEX_HOLD_MS);
    await expectNoDecision(await pending);
  });

  it("ignores a PostToolUse that arrives with no request to match", async () => {
    const h = boot();
    observe(h, codexPreToolUse("call-1"));
    observe(h, codexPostToolUse("call-1"));
    expect(resolved(h)).toEqual([]);
  });
});

describe("an Interrupt for the request's turn", () => {
  it("records it answered elsewhere without a decision and releases the hold", async () => {
    const h = boot();
    observe(h, codexPreToolUse("call-1"));
    const pending = postCodexPermission(h.app, codexPermissionHook());
    const requestId = await heldRequestId(h.engine);

    observe(h, codexInterrupt());
    await expectNoDecision(await within(pending));
    const [event] = resolved(h);
    expect(resolved(h)).toHaveLength(1);
    expect(event?.payload).toMatchObject({ requestId, resolution: "answered_elsewhere" });
    // Esc and a plain interrupt look the same, so no allow or deny is claimed.
    expect(event?.payload).not.toHaveProperty("decision");
  });

  it("leaves a request of another turn alone", async () => {
    const h = boot();
    const pending = postCodexPermission(h.app, codexPermissionHook());
    const requestId = await heldRequestId(h.engine);
    observe(h, codexInterrupt({ turn_id: OTHER_TURN }));
    expect(resolved(h)).toEqual([]);
    expect(h.bridge.decide(requestId, { behavior: "allow" })).toBe(true);
    await pending;
  });
});
