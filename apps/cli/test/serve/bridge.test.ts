import { randomUUID } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { cli, freePort, tempDir } from "../helpers.ts";
import {
  type BridgeServe,
  CWD,
  PROJECT,
  postToolUse,
  SESSION,
  type StoredEvent,
  sessionStart,
  startBridgeServe,
  type Viewer,
} from "./bridge-harness.ts";

// M4.04 (#61): the full ARCHITECTURE.md 9.1 sequence through a real `taskville serve` composition
// (in process, temp home): a fake Claude Code hook client, a paired browser with a viewer stream,
// and the shim's telemetry route. Decision #116 D4: a decision is "sent, unconfirmed"; a later
// PostToolUse never upgrades the command and never records a second resolution.

/** Fails fast when a held hook should have been answered, instead of hanging the file. */
function within<T>(promise: Promise<T>, ms = 5000): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

const ALLOW_JSON = JSON.stringify({
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
});
const denyJson = (message: string) =>
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision: { behavior: "deny", message },
    },
  });

/** A fresh prompt and command per test, so the PostToolUse match is never ambiguous. */
function call(label: string) {
  const promptId = randomUUID();
  const toolInput = { command: `echo ${label}`, description: `Run ${label}` };
  return {
    hook: { prompt_id: promptId, tool_input: toolInput },
    post: postToolUse({
      prompt_id: promptId,
      tool_input: toolInput,
      tool_use_id: `toolu_${label}`,
    }),
  };
}

const decide = (requestId: string, decision: unknown, idempotencyKey: string) => ({
  type: "permission.decide",
  projectId: PROJECT,
  requestId,
  idempotencyKey,
  decision,
});

const requestIdOf = (event: StoredEvent) => String(event.payload.requestId);
/** The request.opened for the call made with `call(label)`: a replayed stream also holds older ones. */
const openedFor = (viewer: Viewer, label: string) =>
  viewer.waitFor(
    (e) => e.type === "request.opened" && String(e.payload.inputPreview ?? "").includes(label),
  );
const forRequest = (events: StoredEvent[], type: string, requestId: string) =>
  events.filter((event) => event.type === type && event.payload.requestId === requestId);

describe("taskville serve: bridge and command integration (ARCHITECTURE 9.1)", () => {
  let h: BridgeServe;
  beforeAll(async () => {
    h = await startBridgeServe();
    // Claude Code's first hook registers the session and its agent.
    const started = await h.telemetry(sessionStart());
    expect(started.status).toBe(200);
  });
  afterAll(async () => {
    expect(await h.stop()).toBe(0);
    h.remove();
  });

  const getCommand = (id: string) =>
    fetch(`${h.url}/v1/commands/${id}`, { headers: { "X-Taskville-Session": h.session } });

  it("allow: hook held, viewer sees request.opened, decide allow, hook gets exactly the allow JSON, viewer sees resolved and delivered, a later PostToolUse changes nothing", async () => {
    const viewer = await h.viewer();
    try {
      const c = call("allow-1");
      const held = h.hook(c.hook);
      const opened = await openedFor(viewer, "allow-1");
      const requestId = requestIdOf(opened);
      expect(opened.sourceId).toBe("taskville:bridge");
      expect(opened.payload).toMatchObject({ kind: "permission", toolName: "Bash" });

      const res = await h.command(decide(requestId, { behavior: "allow" }, "allow-1"));
      expect(res.status).toBe(200);
      const { command } = (await res.json()) as { command: { id: string; status: string } };
      expect(command.status).toBe("delivered");

      const answered = await within(held);
      expect(answered.status).toBe(200);
      expect(await answered.text()).toBe(ALLOW_JSON);

      const resolved = await viewer.waitFor(
        (e) => e.type === "request.resolved" && e.payload.requestId === requestId,
      );
      expect(resolved.payload).toMatchObject({ resolution: "answered_here", decision: "allow" });
      const delivered = await viewer.waitFor(
        (e) => e.type === "command.delivered" && e.payload.commandId === command.id,
      );
      expect(delivered.type).toBe("command.delivered");

      // The tool ran; Claude Code's PostToolUse arrives through the telemetry route.
      const post = await h.telemetry(c.post);
      expect(post.status).toBe(200);
      const events = await h.allEvents();
      expect(forRequest(events, "request.resolved", requestId)).toHaveLength(1);
      expect(events.some((e) => e.type === "command.succeeded")).toBe(false);
      expect(
        events.some(
          (e) =>
            e.type === "request.resolved" &&
            e.payload.requestId === requestId &&
            e.payload.resolution === "answered_elsewhere",
        ),
      ).toBe(false);
      const after = await getCommand(command.id);
      expect(((await after.json()) as { command: { status: string } }).command.status).toBe(
        "delivered",
      );
    } finally {
      await viewer.close();
    }
  });

  it("deny with a note: the hook gets the cleaned note, and a later PostToolUse changes nothing", async () => {
    const viewer = await h.viewer();
    try {
      const c = call("deny-1");
      const held = h.hook(c.hook);
      const requestId = requestIdOf(await openedFor(viewer, "deny-1"));
      const res = await h.command(
        decide(requestId, { behavior: "deny", message: "not\u0007 now, thanks" }, "deny-1"),
      );
      expect(res.status).toBe(200);
      const answered = await within(held);
      expect(await answered.text()).toBe(denyJson("not now, thanks"));
      await viewer.waitFor(
        (e) => e.type === "request.resolved" && e.payload.requestId === requestId,
      );
      expect((await h.telemetry(c.post)).status).toBe(200);
      const events = await h.allEvents();
      expect(forRequest(events, "request.resolved", requestId)).toHaveLength(1);
      expect(events.some((e) => e.type === "command.succeeded")).toBe(false);
    } finally {
      await viewer.close();
    }
  });

  it("a double click (the same idempotency key twice) answers once", async () => {
    const viewer = await h.viewer();
    try {
      const held = h.hook(call("double-1").hook);
      const requestId = requestIdOf(await openedFor(viewer, "double-1"));
      const body = decide(requestId, { behavior: "allow" }, "double-1");
      const [first, second] = await Promise.all([h.command(body), h.command(body)]);
      expect([first.status, second.status]).toEqual([200, 200]);
      const a = ((await first.json()) as { command: { id: string } }).command.id;
      const b = ((await second.json()) as { command: { id: string } }).command.id;
      expect(b).toBe(a);
      expect(await (await within(held)).text()).toBe(ALLOW_JSON);
      const events = await h.allEvents();
      expect(forRequest(events, "request.resolved", requestId)).toHaveLength(1);
      expect(
        events.filter((e) => e.type === "command.delivered" && e.payload.commandId === a),
      ).toHaveLength(1);
    } finally {
      await viewer.close();
    }
  });

  it("a forged PostToolUse (CLI or shim token) never produces a hook allow: it only records the terminal-allow outcome (security review M3)", async () => {
    const viewer = await h.viewer();
    try {
      const c = call("forged-1");
      const held = h.hook(c.hook);
      const requestId = requestIdOf(await openedFor(viewer, "forged-1"));
      const forged = await h.telemetry(c.post);
      expect(forged.status).toBe(200);
      // The held hook is released with the empty 2xx (Claude Code's own dialog decides), not an allow.
      const released = await within(held);
      expect(released.status).toBe(200);
      expect(await released.text()).toBe("");
      const resolved = await viewer.waitFor(
        (e) => e.type === "request.resolved" && e.payload.requestId === requestId,
      );
      expect(resolved.payload).toMatchObject({
        resolution: "answered_elsewhere",
        decision: "allow",
      });
      // The request is closed: the city can no longer answer it, and no command was delivered.
      const late = await h.command(decide(requestId, { behavior: "allow" }, "forged-late"));
      expect(late.status).toBe(409);
      const lateBody = (await late.json()) as { error: { code: string }; command: { id: string } };
      expect(lateBody.error.code).toBe("request_not_open");
      const events = await h.allEvents();
      expect(
        events.some(
          (e) => e.type === "command.delivered" && e.payload.commandId === lateBody.command.id,
        ),
      ).toBe(false);
    } finally {
      await viewer.close();
    }
  });

  it("a PostToolUse after fall-through (no viewer, so the request was never held) records the terminal allow", async () => {
    // A project nobody watches: the hook gets the empty 2xx at once and the request stays open.
    const quietRoot = "/tmp/spike-s1/quiet";
    await h.addProject("quiet", quietRoot);
    const quietSession = randomUUID();
    const started = await h.telemetry({
      ...sessionStart(),
      session_id: quietSession,
      cwd: quietRoot,
    });
    expect(started.status).toBe(200);
    const c = call("fallthrough-1");
    const overrides = { ...c.hook, session_id: quietSession, cwd: quietRoot };
    const res = await within(h.hook(overrides));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    const before = await h.allEvents("quiet");
    const opened = before.find((e) => e.type === "request.opened");
    expect(opened?.sourceId).toBe("taskville:bridge-unheld");
    const requestId = requestIdOf(opened as StoredEvent);

    const post = await h.telemetry({ ...c.post, session_id: quietSession, cwd: quietRoot });
    expect(post.status).toBe(200);
    const after = await h.allEvents("quiet");
    const [resolved, ...rest] = forRequest(after, "request.resolved", requestId);
    expect(rest).toEqual([]);
    expect(resolved?.payload).toMatchObject({
      resolution: "answered_elsewhere",
      decision: "allow",
    });
  });

  it("the input route: a request recorded but never held is 410 request_expired, and 404 unknown_request under another project", async () => {
    // A project nobody watches: the hook gets the empty 2xx at once, so the request is recorded
    // (taskville:bridge-unheld) but the bridge never held it. The answer comes from the projection.
    const unheldRoot = "/tmp/spike-s1/unheld-input";
    await h.addProject("unheld-input", unheldRoot);
    const unheldSession = randomUUID();
    expect(
      (await h.telemetry({ ...sessionStart(), session_id: unheldSession, cwd: unheldRoot })).status,
    ).toBe(200);
    const c = call("unheld-input-1");
    const res = await within(h.hook({ ...c.hook, session_id: unheldSession, cwd: unheldRoot }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    const opened = (await h.allEvents("unheld-input")).find((e) => e.type === "request.opened");
    expect(opened?.sourceId).toBe("taskville:bridge-unheld");
    const requestId = requestIdOf(opened as StoredEvent);

    const expired = await h.requestInput(requestId, "unheld-input");
    expect(expired.status).toBe(410);
    expect(((await expired.json()) as { error: { code: string } }).error.code).toBe(
      "request_expired",
    );

    // The same ID asked under a project that exists (the demo project) or does not: not found.
    for (const projectId of [PROJECT, "no-such-project"]) {
      const other = await h.requestInput(requestId, projectId);
      expect(other.status, projectId).toBe(404);
      expect(((await other.json()) as { error: { code: string } }).error.code).toBe(
        "unknown_request",
      );
    }
  });

  it("registers the real command routes (a bad body is 400, not the 501 stub)", async () => {
    const res = await h.command({});
    expect(res.status).toBe(400);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe("bad_request");
    expect((await getCommand("nope")).status).toBe(404);
  });

  it("serves the exact input of a held request to the paired browser only, and not once it is answered", async () => {
    const viewer = await h.viewer();
    try {
      const c = call("input-1");
      const held = h.hook(c.hook);
      const requestId = requestIdOf(await openedFor(viewer, "input-1"));
      const ok = await h.requestInput(requestId);
      expect(ok.status).toBe(200);
      expect(ok.headers.get("cache-control")).toBe("no-store");
      expect(await ok.json()).toEqual({
        requestId,
        projectId: PROJECT,
        sessionId: SESSION,
        toolName: "Bash",
        toolInput: c.hook.tool_input,
        cwd: CWD,
      });
      const url = `${h.url}/v1/requests/${encodeURIComponent(requestId)}/input?projectId=${PROJECT}`;
      for (const token of [h.cliToken, h.bridgeToken]) {
        const refused = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
        expect(refused.status).toBe(403);
        expect(((await refused.json()) as { error: { code: string } }).error.code).toBe(
          "credential_not_allowed",
        );
      }
      expect((await h.requestInput(requestId, "elsewhere")).status).toBe(404);
      expect((await h.command(decide(requestId, { behavior: "allow" }, "input-1"))).status).toBe(
        200,
      );
      await within(held);
      expect((await h.requestInput(requestId)).status).toBe(410);
    } finally {
      await viewer.close();
    }
  });
});

describe("taskville serve: shutdown", () => {
  it("bridge.close() runs on shutdown: a held hook is released with the empty 2xx", async () => {
    const h = await startBridgeServe();
    let stopped = false;
    try {
      expect((await h.telemetry(sessionStart())).status).toBe(200);
      const viewer = await h.viewer();
      const held = h.hook(call("shutdown-1").hook);
      await openedFor(viewer, "shutdown-1");
      const exit = h.stop();
      const released = await within(held);
      expect(released.status).toBe(200);
      expect(await released.text()).toBe("");
      expect(await exit).toBe(0);
      stopped = true;
      await viewer.close();
    } finally {
      if (!stopped) await h.stop();
      h.remove();
    }
  });
});

describe("taskville serve: hold window config", () => {
  it("refuses a hold window over 300 s at start, with a clear message", async () => {
    const dir = tempDir("taskville-hold-config-");
    try {
      writeFileSync(
        join(dir.path, "config.json"),
        JSON.stringify({ bridge: { holdWindowSeconds: 301 } }),
        {
          mode: 0o600,
        },
      );
      // A deadline, so a build that wrongly starts is stopped instead of hanging the run.
      const result = await cli(
        ["serve", "--headless", "--home", dir.path, "--port", String(await freePort())],
        { cwd: dir.path, signal: AbortSignal.timeout(3000) },
      );
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(
        "bridge.holdWindowSeconds: must be a whole number of seconds from 1 to 300",
      );
      expect(result.stdout).not.toContain("listening");
    } finally {
      dir.remove();
    }
  });

  it("holds a hook for the configured window (1 s), not the 90 s default, then answers the empty 2xx", async () => {
    const h = await startBridgeServe({ config: { bridge: { holdWindowSeconds: 1 } } });
    try {
      expect((await h.telemetry(sessionStart())).status).toBe(200);
      // A viewer is connected, so the bridge holds the hook; nobody answers it.
      const viewer = await h.viewer();
      try {
        const started = Date.now();
        const held = h.hook(call("window-1").hook);
        await openedFor(viewer, "window-1");
        const res = await within(held, 15_000);
        const elapsed = Date.now() - started;
        expect(res.status).toBe(200);
        expect(await res.text()).toBe("");
        // Held for about the window, and well under the 90 s default.
        expect(elapsed).toBeGreaterThanOrEqual(900);
        expect(elapsed).toBeLessThan(10_000);
      } finally {
        await viewer.close();
      }
    } finally {
      expect(await h.stop()).toBe(0);
      h.remove();
    }
  });

  it("starts with the largest allowed window (300 s)", async () => {
    const h = await startBridgeServe({ config: { bridge: { holdWindowSeconds: 300 } } });
    try {
      expect(h.output()).toContain("listening");
    } finally {
      expect(await h.stop()).toBe(0);
      h.remove();
    }
  });
});
