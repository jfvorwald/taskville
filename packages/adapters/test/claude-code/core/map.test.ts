import { parseInputEvent, producerPolicyViolation } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import {
  type HookContext,
  type MapResult,
  mapClaudeCodeHook,
  sessionAgentId,
  subagentAgentId,
} from "../../../src/claude-code/index.ts";
import { redactText } from "../../../src/redact/index.ts";

// Unit behavior of the core Claude Code hook mapper (M2.03, ARCHITECTURE.md 8.1, 8.3).
// Every emitted event must also be a valid protocol v1 input event a producer may send.

const SID = "1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const ctx: HookContext = {
  projectId: "proj-1",
  sourceEventId: "e-1",
  receivedAt: "2026-10-30T12:00:00.000Z",
  late: false,
};
const base = { session_id: SID, cwd: "/tmp/spike-s2/proj", transcript_path: "/x.jsonl" };

function map(payload: unknown, c: Partial<HookContext> = {}): MapResult {
  const result = mapClaudeCodeHook(payload, { ...ctx, ...c });
  for (const event of result.events) {
    const parsed = parseInputEvent(event);
    expect(parsed, JSON.stringify(event)).toMatchObject({ ok: true });
    if (parsed.ok) expect(producerPolicyViolation(parsed.event)).toBeUndefined();
  }
  return result;
}

const types = (r: MapResult) => r.events.map((e) => e.type);
const only = (r: MapResult, type: string) => {
  const found = r.events.filter((e) => e.type === type);
  expect(found).toHaveLength(1);
  return found[0] as (typeof r.events)[number] & { payload: Record<string, unknown> };
};

const pre = (tool: string, input: unknown, extra: object = {}) => ({
  ...base,
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: input,
  tool_use_id: "toolu_01",
  ...extra,
});

describe("envelope", () => {
  it("fills the envelope from the context, deterministically", () => {
    const r = map({ ...base, hook_event_name: "UserPromptSubmit", prompt: "hi" });
    expect(r.events).toEqual([
      {
        schemaVersion: 1,
        projectId: "proj-1",
        sourceId: "claude-code",
        sourceEventId: "e-1:session.prompt_submitted",
        occurredAt: "2026-10-30T12:00:00.000Z",
        agentId: sessionAgentId(SID),
        sessionId: SID,
        type: "session.prompt_submitted",
        payload: {},
        provenance: "live",
        late: false,
      },
    ]);
    expect(map({ ...base, hook_event_name: "UserPromptSubmit", prompt: "hi" })).toEqual(r);
  });

  it("never copies the prompt text", () => {
    const r = map({ ...base, hook_event_name: "UserPromptSubmit", prompt: "secret plan" });
    expect(JSON.stringify(r)).not.toContain("secret plan");
  });

  it("gives every event of one hook its own sourceEventId", () => {
    const r = map({ ...base, hook_event_name: "SessionStart", source: "startup" });
    const ids = r.events.map((e) => e.sourceEventId);
    expect(new Set(ids).size).toBe(ids.length);
    expect(ids.length).toBeGreaterThan(1);
  });

  it("marks every event late when the context is late", () => {
    const r = map(
      { ...base, hook_event_name: "Notification", notification_type: "permission_prompt" },
      { late: true },
    );
    expect(r.events.length).toBeGreaterThan(0);
    for (const e of r.events) expect(e.late).toBe(true);
  });
});

describe("sessions", () => {
  it("SessionStart registers the session agent and opens the session", () => {
    const r = map({ ...base, hook_event_name: "SessionStart", source: "startup" });
    expect(types(r)).toEqual(["agent.registered", "session.started"]);
    expect(only(r, "agent.registered").payload).toEqual({
      sourceAgentId: SID,
      displayName: "proj",
      role: "main",
      kind: "session",
    });
    expect(only(r, "session.started").payload).toEqual({ workingDirectory: "/tmp/spike-s2/proj" });
  });

  it("SessionStart started with an agent uses agent_type as the role", () => {
    const r = map({ ...base, hook_event_name: "SessionStart", agent_type: "reviewer" });
    expect(only(r, "agent.registered").payload.role).toBe("reviewer");
  });

  it("names a session without a usable cwd generically", () => {
    const r = map({ session_id: SID, hook_event_name: "SessionStart" });
    expect(only(r, "agent.registered").payload.displayName).toBe("Claude Code");
    expect(only(r, "session.started").payload).toEqual({});
  });

  it("SessionEnd closes the session with its reason", () => {
    const r = map({ ...base, hook_event_name: "SessionEnd", reason: "prompt_input_exit" });
    expect(types(r)).toEqual(["session.ended"]);
    expect(only(r, "session.ended").payload).toEqual({ outcome: "prompt_input_exit" });
  });

  it("Stop ends the turn and the activity", () => {
    const r = map({ ...base, hook_event_name: "Stop", last_assistant_message: "done" });
    expect(types(r)).toEqual(["session.turn_ended", "activity.ended"]);
  });

  it("StopFailure fails the turn with the error as reason", () => {
    const r = map({
      ...base,
      hook_event_name: "StopFailure",
      error: "rate_limit",
      error_details: "429 Too Many Requests",
    });
    expect(types(r)).toEqual(["session.turn_failed", "activity.ended"]);
    expect(only(r, "session.turn_failed").payload).toEqual({
      reason: "rate_limit: 429 Too Many Requests",
    });
  });

  it("StopFailure without an error string has no reason", () => {
    const r = map({ ...base, hook_event_name: "StopFailure", error: 42 });
    expect(only(r, "session.turn_failed").payload).toEqual({});
  });
});

describe("tool calls", () => {
  it("PreToolUse opens a ToolCall keyed by tool_use_id, with evidence of the input", () => {
    const input = { file_path: "/tmp/p/notes.txt", old_string: "a", new_string: "b" };
    const r = map(pre("Edit", input));
    expect(types(r)).toEqual(["tool_call.started", "activity.started"]);
    expect(only(r, "tool_call.started").payload).toEqual({
      toolCallId: "toolu_01",
      toolName: "Edit",
      filePaths: ["/tmp/p/notes.txt"],
      summary: "/tmp/p/notes.txt",
    });
    expect(only(r, "activity.started").payload).toEqual({ activity: "implementing" });
    expect(r.evidence).toEqual([{ toolCallId: "toolu_01", input }]);
  });

  it("PostToolUse closes it as succeeded with the duration and output evidence", () => {
    const output = { stdout: "3 notes.txt", stderr: "" };
    const r = map({
      ...pre("Bash", { command: "wc -l notes.txt" }),
      hook_event_name: "PostToolUse",
      tool_response: output,
      duration_ms: 26,
    });
    expect(types(r)).toEqual(["tool_call.finished"]);
    expect(only(r, "tool_call.finished").payload).toEqual({
      toolCallId: "toolu_01",
      phase: "succeeded",
      durationMs: 26,
    });
    expect(r.evidence).toEqual([{ toolCallId: "toolu_01", output }]);
  });

  it("PostToolUseFailure closes it as failed with the error's first line as summary", () => {
    const r = map({
      ...pre("Bash", { command: "cat missing.txt" }),
      hook_event_name: "PostToolUseFailure",
      error: "Exit code 1\ncat: missing.txt: No such file or directory",
      is_interrupt: false,
      duration_ms: 26,
    });
    expect(only(r, "tool_call.finished").payload).toEqual({
      toolCallId: "toolu_01",
      phase: "failed",
      durationMs: 26,
      summary: "Exit code 1",
    });
    expect(r.evidence).toEqual([
      {
        toolCallId: "toolu_01",
        output: {
          error: "Exit code 1\ncat: missing.txt: No such file or directory",
          is_interrupt: false,
        },
      },
    ]);
  });

  it.each([
    ["negative", -1],
    ["fractional", 1.5],
    ["infinite (1e400 parses to Infinity)", JSON.parse("1e400")],
    ["over 30 days", 30 * 24 * 3600 * 1000 + 1],
    ["a string", "26"],
  ])("drops a %s duration", (_name, duration) => {
    const r = map({ ...pre("Read", {}), hook_event_name: "PostToolUse", duration_ms: duration });
    expect(only(r, "tool_call.finished").payload).toEqual({
      toolCallId: "toolu_01",
      phase: "succeeded",
    });
  });

  it("a Pre with no Post leaves only the started call, and a Post with no Pre still maps", () => {
    expect(types(map(pre("Bash", { command: "echo waiting" })))).toEqual(["tool_call.started"]);
    const post = map({ ...pre("Bash", {}), hook_event_name: "PostToolUse" });
    expect(types(post)).toEqual(["tool_call.finished"]);
  });

  it.each([
    ["missing", undefined],
    ["empty", ""],
    ["not a string", 7],
    ["too long", `toolu_${"a".repeat(200)}`],
    ["with a space", "toolu 01"],
  ])("ignores a tool hook whose tool_use_id is %s", (_name, id) => {
    const r = map({ ...pre("Read", {}), tool_use_id: id });
    expect(r.events).toEqual([]);
    expect(r.ignored).toBeTypeOf("string");
  });

  it("ignores a tool hook without a tool name", () => {
    expect(map({ ...pre("", {}) }).events).toEqual([]);
    expect(map({ ...pre("Read", {}), tool_name: 3 }).events).toEqual([]);
  });

  it("summarizes common tools from their input", () => {
    const summary = (tool: string, input: object) =>
      only(map(pre(tool, input)), "tool_call.started").payload.summary;
    expect(summary("Bash", { command: "ls -la", description: "List files" })).toBe("List files");
    expect(summary("Bash", { command: "ls -la" })).toBe("ls -la");
    expect(summary("Grep", { pattern: "TODO" })).toBe("TODO");
    expect(summary("WebFetch", { url: "https://example.com/a" })).toBe("https://example.com/a");
    expect(summary("WebSearch", { query: "vitest" })).toBe("vitest");
    expect(summary("Agent", { description: "Edit notes", prompt: "long" })).toBe("Edit notes");
    expect(summary("Mystery", { x: 1 })).toBeUndefined();
  });

  it("records file paths only from string file_path or notebook_path", () => {
    const paths = (input: object) =>
      only(map(pre("Write", input)), "tool_call.started").payload.filePaths;
    expect(paths({ file_path: "/a/b.ts" })).toEqual(["/a/b.ts"]);
    expect(paths({ notebook_path: "/a/n.ipynb" })).toEqual(["/a/n.ipynb"]);
    expect(paths({ file_path: ["/a"] })).toBeUndefined();
    expect(paths({})).toBeUndefined();
  });
});

describe("activity from tool names (8.1, 8.3)", () => {
  const activityOf = (tool: string, input: object = {}) => {
    const found = map(pre(tool, input)).events.filter((e) => e.type === "activity.started");
    return found.length === 0 ? undefined : (found[0]?.payload as Record<string, unknown>);
  };

  it.each([
    ["Edit", "implementing"],
    ["MultiEdit", "implementing"],
    ["Write", "implementing"],
    ["NotebookEdit", "implementing"],
    ["Read", "researching"],
    ["Grep", "researching"],
    ["Glob", "researching"],
    ["WebFetch", "researching"],
    ["WebSearch", "researching"],
    ["Agent", "dispatching"],
    ["Task", "dispatching"],
  ])("%s maps to %s, not heuristic", (tool, activity) => {
    expect(activityOf(tool)).toEqual({ activity });
  });

  it.each([
    "pnpm test",
    "pnpm --filter @taskville/adapters test",
    "npm run test -- --watch=false",
    "yarn test",
    "npx vitest run",
    "vitest",
    "jest --ci",
    "pytest -q tests/",
    "python -m pytest",
    "python3 -m unittest discover",
    "go test ./...",
    "cargo test",
    "make test",
    "node --test tests/",
    "cd app && bun test",
    "./gradlew test",
    "mvn test",
    "dotnet test",
    "rspec spec/",
    "npx playwright test",
    "pnpm -C app test",
    "pnpm --filter=web test:unit",
    "yarn workspace web test",
    "pnpm -w test",
    "yarn workspace web run test",
    "yarn workspace web run test:unit",
    "npm run test:e2e",
  ])("Bash `%s` maps to testing, flagged heuristic", (command) => {
    expect(activityOf("Bash", { command })).toEqual({ activity: "testing", heuristic: true });
  });

  it.each([
    "ls -la",
    "cat test.txt",
    "git commit -m 'add tests'",
    "echo pytest",
    "mkdir test",
    "grep -r latest src",
    "pnpm -C test build",
    "pnpm --dir test install",
    "npm --prefix test run build",
    "yarn --cwd test build",
    "pnpm --filter test build",
    "pnpm add test",
    "npm run build -- test",
  ])("Bash `%s` sets no activity", (command) => {
    expect(activityOf("Bash", { command })).toBeUndefined();
  });

  it.each(["SendMessage", "ToolSearch", "TodoWrite", "constructor", "__proto__", "toString"])(
    "%s sets no activity",
    (tool) => {
      expect(activityOf(tool)).toBeUndefined();
    },
  );
});

describe("notifications and requests", () => {
  const notification = (type: unknown, extra: object = {}) => ({
    ...base,
    hook_event_name: "Notification",
    message: "Claude needs your permission",
    notification_type: type,
    ...extra,
  });

  it("permission_prompt opens a telemetry permission request", () => {
    const r = map(notification("permission_prompt"));
    expect(types(r)).toEqual(["request.opened"]);
    expect(only(r, "request.opened").payload).toEqual({
      requestId: "claude-code:request:e-1",
      kind: "permission",
      reason: "Claude needs your permission",
    });
    expect(r.events[0]?.sourceId).toBe("claude-code");
  });

  it("carries prompt_id as correlationId, so M4 can match the bridge's request (S-1)", () => {
    const pid = "03dc4896-8835-47f5-a515-94a1ad4c675c";
    const r = map(notification("permission_prompt", { prompt_id: pid }));
    expect(only(r, "request.opened").correlationId).toBe(pid);
    const bad = map(notification("permission_prompt", { prompt_id: "a:b" }));
    expect(only(bad, "request.opened").correlationId).toBeUndefined();
  });

  it("a late permission_prompt still maps, marked late so the reducer never opens it", () => {
    const r = map(notification("permission_prompt"), { late: true });
    expect(only(r, "request.opened").late).toBe(true);
  });

  it("idle_prompt marks the session idle", () => {
    expect(types(map(notification("idle_prompt", { message: "waiting" })))).toEqual([
      "session.idle_prompt",
    ]);
  });

  it.each([
    "worker_permission_prompt",
    "auth_success",
    "elicitation_dialog",
    "toString",
    7,
    undefined,
  ])("ignores notification type %s", (type) => {
    const r = map(notification(type));
    expect(r.events).toEqual([]);
    expect(r.ignored).toBeTypeOf("string");
  });

  it("Elicitation opens an elicitation request with the server and message as reason", () => {
    const r = map({
      ...base,
      hook_event_name: "Elicitation",
      mcp_server_name: "github",
      message: "Pick a repository",
      requested_schema: { type: "object" },
    });
    expect(only(r, "request.opened").payload).toEqual({
      requestId: "claude-code:request:e-1",
      kind: "elicitation",
      reason: "github: Pick a repository",
    });
  });
});

describe("attribution", () => {
  it("a hook fired inside a subagent is attributed to the subagent in the parent's session", () => {
    const r = map(
      pre("Read", {}, { agent_id: "afdf84bea07a9064c", agent_type: "general-purpose" }),
    );
    for (const e of r.events) {
      expect(e.agentId).toBe(subagentAgentId(SID, "afdf84bea07a9064c"));
      expect(e.sessionId).toBe(SID);
    }
    expect(subagentAgentId(SID, "afdf84bea07a9064c")).not.toBe(sessionAgentId(SID));
  });

  it.each([
    ["SessionStart", {}],
    ["SessionEnd", { reason: "other" }],
    ["UserPromptSubmit", {}],
    ["Stop", {}],
    ["StopFailure", { error: "x" }],
    ["Notification", { notification_type: "idle_prompt" }],
  ])(
    "leaves %s from inside an agent to the crew mapper, so no session changes owner",
    (hook, extra) => {
      const r = map({
        ...base,
        hook_event_name: hook,
        agent_id: "apip-5cb5e9bb3f2f1097",
        ...extra,
      });
      expect(r.events).toEqual([]);
      expect(r.ignored).toBeTypeOf("string");
    },
  );

  it("still opens a permission request from inside an agent, attributed to it", () => {
    const r = map({
      ...base,
      hook_event_name: "Notification",
      notification_type: "permission_prompt",
      agent_id: "apip-5cb5e9bb3f2f1097",
    });
    expect(only(r, "request.opened").agentId).toBe(subagentAgentId(SID, "apip-5cb5e9bb3f2f1097"));
  });

  it("accepts in-process and split-pane style agent IDs", () => {
    for (const id of ["apip-5cb5e9bb3f2f1097", "pip@session-a7286c33"]) {
      expect(map(pre("Read", {}, { agent_id: id })).events[0]?.agentId).toBe(
        subagentAgentId(SID, id),
      );
    }
  });

  it.each([
    ["not a string", 5],
    ["empty", ""],
    ["too long", "a".repeat(65)],
    ["with a slash", "a/b"],
  ])("ignores a hook whose agent_id is %s", (_name, id) => {
    const r = map(pre("Read", {}, { agent_id: id }));
    expect(r.events).toEqual([]);
    expect(r.ignored).toBeTypeOf("string");
  });
});

describe("hooks other tickets own", () => {
  it.each([
    "SubagentStart",
    "SubagentStop",
    "TeammateIdle",
    "TaskCreated",
    "TaskCompleted",
    "PermissionRequest",
    "MessageDisplay",
    "ElicitationResult",
    "SomethingNew",
  ])("%s is ignored with a reason", (hook) => {
    const r = map({ ...base, hook_event_name: hook, agent_id: "a1", tool_name: "Bash" });
    expect(r.events).toEqual([]);
    expect(r.ignored).toBeTypeOf("string");
  });
});

describe("untrusted payloads (L-18, L-29, L-31, L-32)", () => {
  it.each([
    ["null", null],
    ["an array", [base]],
    ["a string", "SessionStart"],
    ["a number", 1],
  ])("ignores a payload that is %s", (_name, payload) => {
    const r = map(payload);
    expect(r.events).toEqual([]);
    expect(r.ignored).toBeTypeOf("string");
  });

  it.each([
    ["missing", undefined],
    ["not a string", 1],
    ["empty", ""],
    ["too long", "s".repeat(101)],
    ["with a newline", "s\n"],
    ["with a colon", "a:b"],
    ["a credential the redactor would mask", `sk-ant-${"A1b2C3d4".repeat(5)}`],
  ])("ignores a hook whose session_id is %s", (_name, sid) => {
    const r = map({ ...base, session_id: sid, hook_event_name: "Stop" });
    expect(r.events).toEqual([]);
    expect(r.ignored).toBeTypeOf("string");
  });

  it("ignores hook names inherited from Object.prototype", () => {
    for (const name of ["toString", "constructor", "__proto__", "hasOwnProperty"]) {
      expect(map({ ...base, hook_event_name: name }).events).toEqual([]);
    }
  });

  it("reads only own fields, so a __proto__ key cannot supply one", () => {
    const payload = JSON.parse(
      `{"__proto__": {"session_id": "${SID}", "hook_event_name": "Stop"}, "cwd": "/x"}`,
    );
    expect(map(payload).events).toEqual([]);
  });

  it("ignores a context whose sourceEventId leaves no room for derived IDs", () => {
    const r = map({ ...base, hook_event_name: "Stop" }, { sourceEventId: "x".repeat(171) });
    expect(r.events).toEqual([]);
    expect(r.ignored).toBeTypeOf("string");
    expect(
      map({ ...base, hook_event_name: "Stop" }, { sourceEventId: "x".repeat(170) }).events,
    ).not.toEqual([]);
  });

  it("masks secrets in summaries before they enter an event", () => {
    const key = `sk-ant-${"A1b2C3d4".repeat(5)}`;
    const r = map(pre("Bash", { command: `curl -H "x-api-key: ${key}" https://api` }));
    const text = JSON.stringify(r.events);
    expect(text).not.toContain(key);
    expect(text).toContain("[REDACTED:");
  });

  // The engine masks `reason` at ingest and records `masked: true` when it did (FR-017). Masking
  // it here first would hide that, so a reason within the input limit is left to the engine.
  it.each([
    ["StopFailure", { error: "auth failed for KEY" }, "session.turn_failed"],
    ["Notification", { notification_type: "permission_prompt", message: "KEY" }, "request.opened"],
    ["Elicitation", { message: "token KEY" }, "request.opened"],
  ])("leaves a secret in a %s reason for the engine to mask and flag", (hook, extra, type) => {
    const key = `sk-ant-${"A1b2C3d4".repeat(5)}`;
    const payload = JSON.parse(
      JSON.stringify({ ...base, hook_event_name: hook, ...extra }).replaceAll("KEY", key),
    );
    const reason = only(map(payload), type).payload.reason as string;
    expect(reason).toContain(key);
  });

  it("cuts an over-long reason unmasked but never inside a secret, so the engine still flags it", () => {
    const key = `sk-ant-${"A1b2C3d4".repeat(5)}`;
    const reasonOf = (error: string) =>
      only(map({ ...base, hook_event_name: "StopFailure", error }), "session.turn_failed").payload
        .reason as string;
    // A secret near the start stays whole and unmasked, for the engine to mask and flag.
    const early = reasonOf(`${key} ${"x".repeat(5000)}`);
    expect([...early].length).toBe(4000);
    expect(early.startsWith(`${key} `)).toBe(true);
    expect(early).not.toContain("[REDACTED:");
    // A secret across the cut is dropped whole, never left half visible.
    const across = reasonOf(`${"x".repeat(3990)} ${key} tail`);
    expect(across).toBe(`${"x".repeat(3990)} `);
  });

  it("never keeps a secret whose detecting context the cut removed (job 5100)", () => {
    // `https://user:<password>@host`: the password is a secret only because of the `@` after it.
    // With the password ending exactly at the cut, keeping it would drop the `@`.
    for (const pad of [0, 1, 2, 5]) {
      const password = "q".repeat(3987 - pad);
      const error = `${"x".repeat(pad)}https://user:${password}@host and more text`;
      const reason = only(
        map({ ...base, hook_event_name: "StopFailure", error }),
        "session.turn_failed",
      ).payload.reason as string;
      expect([...reason].length).toBeLessThanOrEqual(4000);
      // What the engine would store after masking the reason it receives.
      expect(redactText(reason).text).not.toContain("q".repeat(20));
    }
  });

  it("masks secrets in tool names, paths, display names, outcomes and working directories", () => {
    const key = `ghp_${"a1B2".repeat(10)}`;
    const all = [
      map(pre(`mcp-${key}`, { file_path: `/tmp/${key}` })),
      map({ ...base, cwd: `/tmp/${key}`, hook_event_name: "SessionStart" }),
      map({ ...base, hook_event_name: "SessionEnd", reason: key }),
    ];
    for (const r of all) {
      expect(r.events.length).toBeGreaterThan(0);
      expect(JSON.stringify(r.events)).not.toContain(key);
    }
  });

  it("bounds summaries after masking, counting code points", () => {
    const long = `${"x".repeat(500)} sk-ant-${"A1b2C3d4".repeat(5)}`;
    const summary = only(map(pre("Bash", { command: long })), "tool_call.started").payload
      .summary as string;
    expect([...summary].length).toBeLessThanOrEqual(280);
    const emoji = "\u{1F600}".repeat(400);
    const s2 = only(map(pre("Bash", { command: emoji })), "tool_call.started").payload
      .summary as string;
    expect([...s2].length).toBe(280);
    expect(s2.isWellFormed()).toBe(true);
  });

  it("replaces lone surrogates so one bad string cannot fail the event", () => {
    const r = map(pre("Bash", { command: "echo \uD800 done" }));
    const summary = only(r, "tool_call.started").payload.summary as string;
    expect(summary.isWellFormed()).toBe(true);
    expect(summary).toBe("echo \uFFFD done");
  });
});
