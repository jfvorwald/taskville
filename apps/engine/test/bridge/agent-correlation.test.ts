import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapClaudeCodeHook } from "@taskville/adapters/claude-code";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_LOSSY_SESSIONS, MAX_TRACKED_REQUESTS } from "../../src/bridge/index.ts";
import { input } from "../stream/helpers.ts";
import {
  AGENT,
  type BridgeHarness,
  bootBridge,
  bootFailingBridge,
  CWD,
  eventsOf,
  eventually,
  fakeGithubToken,
  heldRequestId,
  permissionHook,
  postPermission,
  postToolUseHook,
  projectState,
  requestsOf,
  SESSION,
  useDbPath,
  within,
} from "./helpers.ts";

// Round 4 of roborev 5808 (M4.02, #51): per-agent correlation, hook ID validation, attribution of
// a child agent's request, the lossy-overflow guard, and the UTF-8 byte cap (the cap's tests are
// in review-fixes.test.ts). Payload shapes are the S-2 recordings, fixtures/claude-code/team/
// in-process.jsonl (pip's PermissionRequest at seq 31 and PostToolUse at seq 38, bo's PostToolUse
// at seq 33) and fixtures/claude-code/subagent/parallel.jsonl (subagent agent_id and agent_type).

const dbPath = useDbPath();
let harness: BridgeHarness | undefined;
afterEach(() => {
  harness?.bridge.close();
  harness?.engine.close();
  harness = undefined;
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const resolvedEvents = (h: BridgeHarness) => eventsOf(h.engine, "request.resolved");
const answerableOpen = (h: BridgeHarness) =>
  requestsOf(h.engine).filter((r) => r.answerable && r.state === "open");

const FIXTURES = join(import.meta.dirname, "../../../../fixtures/claude-code");

/** The raw hook JSON at `seq` of an S-2 recording, placed in the test project and session. */
function fixtureHook(file: string, seq: number): Record<string, unknown> {
  const line = readFileSync(join(FIXTURES, file), "utf8")
    .trim()
    .split("\n")
    .map((text) => JSON.parse(text) as { seq: number; input: Record<string, unknown> })
    .find((record) => record.seq === seq);
  if (line === undefined) throw new Error(`no seq ${seq} in ${file}`);
  // The recording's cwd and session are not this test's project and registered lead agent.
  return { ...line.input, cwd: CWD, session_id: SESSION };
}

/** pip's PermissionRequest (an in-process teammate; its `touch` hit an ask rule). */
const pipRequest = () => fixtureHook("team/in-process.jsonl", 31);
/** pip's PostToolUse for that same call (the terminal Yes). */
const pipPost = () => fixtureHook("team/in-process.jsonl", 38);

interface Child {
  label: string;
  agent_id: string;
  agent_type: string;
}
interface Pair {
  name: string;
  a: Child;
  b: Child;
}
// Teammates: bo's agent_id and agent_type are the recording's. Subagents: both ids are the two
// parallel subagents of parallel.jsonl (agent_type "general-purpose").
const PAIRS: Pair[] = [
  {
    name: "in-process teammates",
    a: { label: "pip", agent_id: "apip-5cb5e9bb3f2f1097", agent_type: "pip" },
    b: { label: "bo", agent_id: "abo-4381c522227780d5", agent_type: "bo" },
  },
  {
    name: "subagents",
    a: { label: "A", agent_id: "afdf84bea07a9064c", agent_type: "general-purpose" },
    b: { label: "B", agent_id: "a0b4668e13e056653", agent_type: "general-purpose" },
  },
];

const childAgentId = (child: Child) => `claude-code:${SESSION}:${child.agent_id}`;
const asChild = (hook: Record<string, unknown>, child: Child) => ({
  ...hook,
  agent_id: child.agent_id,
  agent_type: child.agent_type,
});
const withoutAgent = (hook: Record<string, unknown>) => {
  const { agent_id: _id, agent_type: _type, ...rest } = hook;
  return rest;
};

/** Registers the children the way the telemetry adapter does (core mapper, `agent.registered`). */
function registerChildren(h: BridgeHarness, ...children: Child[]): void {
  h.engine.pipeline.ingest(
    children.map((child) =>
      input(`child-${child.agent_id}`, {
        type: "agent.registered",
        agentId: childAgentId(child),
        sessionId: SESSION,
        sourceId: "claude-code",
        payload: {
          sourceAgentId: child.agent_id,
          displayName: child.label,
          role: child.agent_type,
          kind: "subagent",
          parentAgentId: AGENT,
        },
      }),
    ),
  );
}

describe("a PostToolUse closes only the request of the agent that ran the tool (roborev 5808 #1)", () => {
  describe.each(PAIRS)("$name", ({ a, b }) => {
    it("records no terminal allow for agent A's held request when agent B runs the identical call", async () => {
      harness = bootBridge(dbPath());
      const h = harness;
      h.connectViewer();
      registerChildren(h, a, b);

      const pending = postPermission(h.app, asChild(pipRequest(), a));
      const requestId = await heldRequestId(h.engine);

      // Same session, prompt, tool, and input; only the agent differs.
      h.bridge.observeHook(asChild(pipPost(), b));
      await sleep(30);

      expect(resolvedEvents(h)).toEqual([]);
      expect(projectState(h.engine).requests[requestId]?.state).toBe("open");
      expect(h.bridge.lookup(requestId)).toBeDefined();

      h.bridge.close();
      await pending;
    });

    it("still records the terminal allow when agent A itself runs the call", async () => {
      harness = bootBridge(dbPath());
      const h = harness;
      h.connectViewer();
      registerChildren(h, a, b);

      const pending = postPermission(h.app, asChild(pipRequest(), a));
      const requestId = await heldRequestId(h.engine);

      h.bridge.observeHook(asChild(pipPost(), a));

      const [resolved] = await eventually(() => {
        const events = resolvedEvents(h);
        expect(events).toHaveLength(1);
        return events;
      });
      expect(resolved?.payload).toMatchObject({
        requestId,
        resolution: "answered_elsewhere",
        decision: "allow",
      });
      expect((await pending).status).toBe(200);
    });

    it("closes each agent's own request when both asked for the identical call", async () => {
      let n = 0;
      harness = bootBridge(dbPath(), { newRequestId: () => `bridge:request:pair-${n++}` });
      const h = harness;
      h.connectViewer();
      registerChildren(h, a, b);

      const first = postPermission(h.app, asChild(pipRequest(), a));
      await eventually(() => expect(answerableOpen(h)).toHaveLength(1));
      const second = postPermission(h.app, asChild(pipRequest(), b));
      await eventually(() => expect(answerableOpen(h)).toHaveLength(2));
      const idOf = (child: Child) => {
        const found = requestsOf(h.engine).find((r) => r.agentId === childAgentId(child));
        if (found === undefined) throw new Error(`no request for ${child.label}`);
        return found.id;
      };

      // Per-agent keys: the two requests are not ambiguous, so A's PostToolUse closes A's only.
      h.bridge.observeHook(asChild(pipPost(), a));
      await eventually(() => expect(resolvedEvents(h)).toHaveLength(1));

      expect(resolvedEvents(h)[0]?.payload).toMatchObject({
        requestId: idOf(a),
        decision: "allow",
      });
      expect(h.bridge.lookup(idOf(b))).toBeDefined();

      h.bridge.close();
      await Promise.all([first, second]);
    });

    it("does not let the lead's PostToolUse (no agent_id) close the child's request", async () => {
      harness = bootBridge(dbPath());
      const h = harness;
      h.connectViewer();
      registerChildren(h, a);

      const pending = postPermission(h.app, asChild(pipRequest(), a));
      const requestId = await heldRequestId(h.engine);

      h.bridge.observeHook(withoutAgent(pipPost()));
      await sleep(30);

      expect(resolvedEvents(h)).toEqual([]);
      expect(h.bridge.lookup(requestId)).toBeDefined();

      h.bridge.close();
      await pending;
    });

    it("does not let the child's PostToolUse close the lead's request", async () => {
      harness = bootBridge(dbPath());
      const h = harness;
      h.connectViewer();
      registerChildren(h, a);

      const pending = postPermission(h.app, withoutAgent(pipRequest()));
      const requestId = await heldRequestId(h.engine);

      h.bridge.observeHook(asChild(pipPost(), a));
      await sleep(30);

      expect(resolvedEvents(h)).toEqual([]);
      expect(h.bridge.lookup(requestId)).toBeDefined();

      h.bridge.close();
      await pending;
    });
  });

  it("keeps closing the lead's own request by the lead's own PostToolUse (no agent_id on either)", async () => {
    harness = bootBridge(dbPath());
    const h = harness;
    h.connectViewer();

    const pending = postPermission(h.app, withoutAgent(pipRequest()));
    const requestId = await heldRequestId(h.engine);

    h.bridge.observeHook(withoutAgent(pipPost()));

    const [resolved] = await eventually(() => {
      const events = resolvedEvents(h);
      expect(events).toHaveLength(1);
      return events;
    });
    expect(resolved?.payload).toMatchObject({ requestId, decision: "allow" });
    expect((await pending).status).toBe(200);
  });
});

describe("a session_id that is not a valid hook ID is refused (roborev 5808 #2)", () => {
  const token = fakeGithubToken();
  const INVALID: [string, unknown][] = [
    ["a secret-shaped value", token],
    ["a value with a colon", "sess:ion"],
    ["a value with a space", "bad session"],
    ["a value that starts with a hyphen", "-session"],
    ["a value over 100 characters", "s".repeat(101)],
  ];

  it.each(INVALID)("answers %s with an empty 2xx and records nothing", async (_label, bad) => {
    harness = bootBridge(dbPath());
    const h = harness;
    h.connectViewer();
    const headBefore = h.engine.storage.head("demo");
    const hook = permissionHook({ session_id: bad });

    // The telemetry route (ClaudeCodeSource.ingestHook) answers 200 with `ignored` and records
    // nothing for this payload: the mapper's attribution rejects the session_id.
    const telemetry = mapClaudeCodeHook(hook, {
      projectId: "demo",
      sourceEventId: "11111111-1111-4111-8111-111111111111",
      receivedAt: "2026-10-31T00:00:00.000Z",
      late: false,
    });
    expect(telemetry.events).toEqual([]);

    // Never blocks Claude Code: an empty 2xx, not a 4xx and not a held response.
    const res = await within(postPermission(h.app, hook));
    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(await res.text()).toBe("");

    expect(h.engine.storage.head("demo")).toBe(headBefore);
    expect(eventsOf(h.engine, "request.opened")).toEqual([]);
    expect(requestsOf(h.engine)).toEqual([]);
    expect(h.bridge.stats()).toMatchObject({ held: 0, tracked: 0 });
    // Nothing unmasked reaches storage: no event carries the value, in any field.
    expect(JSON.stringify([...h.engine.storage.events("demo")])).not.toContain(token);
    expect(h.scheduler.pending).toBe(0);
  });

  it("refuses a secret-shaped agent_id the same way, as the telemetry attribution does", async () => {
    harness = bootBridge(dbPath());
    const h = harness;
    h.connectViewer();
    const headBefore = h.engine.storage.head("demo");

    const res = await within(
      postPermission(h.app, permissionHook({ agent_id: token, agent_type: "pip" })),
    );

    expect(res.status).toBeGreaterThanOrEqual(200);
    expect(res.status).toBeLessThan(300);
    expect(await res.text()).toBe("");
    expect(h.engine.storage.head("demo")).toBe(headBefore);
    expect(requestsOf(h.engine)).toEqual([]);
    expect(JSON.stringify([...h.engine.storage.events("demo")])).not.toContain(token);
  });

  it("still holds a request whose session_id is a valid UUID", async () => {
    harness = bootBridge(dbPath());
    const h = harness;
    h.connectViewer();

    const pending = postPermission(h.app, permissionHook());
    await heldRequestId(h.engine);

    h.bridge.close();
    await pending;
  });
});

describe("a child agent's PermissionRequest opens on that child (roborev 5808 #3)", () => {
  /** The agentId the telemetry adapter assigns to a hook (its `tool_call.finished` event). */
  function telemetryAgentId(hook: Record<string, unknown>): string {
    const mapped = mapClaudeCodeHook(hook, {
      projectId: "demo",
      sourceEventId: "22222222-2222-4222-8222-222222222222",
      receivedAt: "2026-10-31T00:00:00.000Z",
      late: false,
    });
    const [event] = mapped.events;
    if (event === undefined) throw new Error("telemetry mapped nothing");
    return (event as { agentId: string }).agentId;
  }

  it.each(PAIRS)(
    "opens the $name request on the agent the telemetry adapter assigns",
    async ({ a }) => {
      harness = bootBridge(dbPath());
      const h = harness;
      h.connectViewer();
      registerChildren(h, a);
      const expected = telemetryAgentId(asChild(pipPost(), a));
      expect(expected).toBe(childAgentId(a));

      const pending = postPermission(h.app, asChild(pipRequest(), a));
      const requestId = await heldRequestId(h.engine);

      const [opened] = eventsOf(h.engine, "request.opened");
      expect(opened).toMatchObject({ agentId: expected, sessionId: SESSION });
      expect(projectState(h.engine).requests[requestId]?.agentId).toBe(expected);

      h.bridge.close();
      await pending;
    },
  );

  it("closes the child's request on the same child agent", async () => {
    harness = bootBridge(dbPath());
    const h = harness;
    h.connectViewer();
    const [pip] = PAIRS;
    if (pip === undefined) throw new Error("no pair");
    registerChildren(h, pip.a);

    const pending = postPermission(h.app, asChild(pipRequest(), pip.a));
    await heldRequestId(h.engine);
    h.bridge.observeHook(asChild(pipPost(), pip.a));

    const [resolved] = await eventually(() => {
      const events = resolvedEvents(h);
      expect(events).toHaveLength(1);
      return events;
    });
    expect(resolved).toMatchObject({ agentId: childAgentId(pip.a), sessionId: SESSION });
    await pending;
  });

  it("keeps a request without agent_id on the lead's session agent", async () => {
    harness = bootBridge(dbPath());
    const h = harness;
    h.connectViewer();

    const pending = postPermission(h.app, withoutAgent(pipRequest()));
    await heldRequestId(h.engine);

    const [opened] = eventsOf(h.engine, "request.opened");
    expect(opened?.agentId).toBe(AGENT);

    h.bridge.close();
    await pending;
  });
});

describe("after the lossy-session set overflowed, no PostToolUse is attributed (roborev 5805, 38b0119)", () => {
  it("records no terminal allow for a matching PostToolUse", async () => {
    // Commits are stubbed while the tracking and lossy caps fill: thousands of real appends take
    // a minute. One session per request, so each request past the tracking cap marks one session
    // lossy, and more than MAX_LOSSY_SESSIONS of them push the set over its bound.
    const h = bootFailingBridge(dbPath());
    harness = h;
    h.state.stub = true;
    const total = MAX_TRACKED_REQUESTS + MAX_LOSSY_SESSIONS + 100;
    for (let i = 0; i < total; i++) {
      await h.bridge.handle(
        permissionHook({ session_id: `overflow-${i}` }),
        new AbortController().signal,
      );
    }
    expect(h.bridge.stats().lossySessions).toBe(MAX_LOSSY_SESSIONS);

    // A request in a session that never lost a request, held for real.
    h.state.stub = false;
    h.connectViewer();
    const pending = h.bridge.handle(permissionHook(), new AbortController().signal);
    const requestId = await heldRequestId(h.engine);

    h.bridge.observeHook(postToolUseHook());
    await sleep(30);

    expect(resolvedEvents(h)).toEqual([]);
    expect(projectState(h.engine).requests[requestId]?.state).toBe("open");
    expect(h.bridge.lookup(requestId)).toBeDefined();

    h.bridge.close();
    await pending;
  }, 120_000);
});
