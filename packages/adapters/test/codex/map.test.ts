import { parseInputEvent, producerPolicyViolation } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import {
  type CodexHookContext,
  type MapResult,
  mapCodexHook,
  requestIdFor,
  sessionAgentId,
  subagentAgentId,
} from "../../src/codex/index.ts";

// Unit behavior of the pure Codex hook mapper (A1.01, docs/spikes/S-5-codex.md "Draft mapping").
//
// Statelessness: like the Claude Code mapper, the mapper holds no state. The two behaviors that
// need to know what came before are driven by optional context fields the engine fills from its
// own records (A1.02 wires them):
// - `knownSession`: false when the engine has never seen this session start, so a SessionEnd
//   (TUI quit before the first prompt) is ignored. Absent means known.
// - `openToolCalls`: the tool calls started and not finished, so an Interrupt can close the ones
//   of its turn. `sourceAgentId` is the hook `agent_id` of a subagent's call, if any.
//
// `returned` is the tool_call.finished phase A1.00 (issue #503) adds to protocol. Until that
// lands, the schema check in `map` rejects a Post event; the literal is used on purpose.

const SID = "01a1bd20-2aeb-78d2-8cd2-11d3026574a7";
const TURN = "01a1bd20-6ac8-70e3-8c1d-0e04db1eed8b";
const CHILD = "01a1bd22-1ffe-77b0-a9f5-0de8a97c2ae1";
const ctx: CodexHookContext = {
  projectId: "proj-1",
  sourceEventId: "e-1",
  receivedAt: "2026-11-08T12:00:00.000Z",
  late: false,
};
const base = {
  session_id: SID,
  cwd: "/tmp/s5-run/proj",
  transcript_path: "~/.codex/sessions/x.jsonl",
  model: "gpt-6-luna",
};
const turnBase = { ...base, turn_id: TURN };

function map(payload: unknown, c: Partial<CodexHookContext> = {}): MapResult {
  const result = mapCodexHook(payload, { ...ctx, ...c });
  for (const event of result.events) {
    const parsed = parseInputEvent(event);
    expect(parsed, JSON.stringify(event)).toMatchObject({ ok: true });
    if (parsed.ok) expect(producerPolicyViolation(parsed.event)).toBeUndefined();
  }
  return result;
}

type Ev = MapResult["events"][number] & { payload: Record<string, unknown> };
const types = (r: MapResult) => r.events.map((e) => e.type);
const all = (r: MapResult, type: string) => r.events.filter((e) => e.type === type) as Ev[];
const only = (r: MapResult, type: string): Ev => {
  const found = all(r, type);
  expect(found).toHaveLength(1);
  return found[0] as Ev;
};

const pre = (tool: string, input: unknown, extra: object = {}) => ({
  ...turnBase,
  hook_event_name: "PreToolUse",
  tool_name: tool,
  tool_input: input,
  tool_use_id: "call_abc123",
  ...extra,
});

describe("envelope and ids", () => {
  it("fills the envelope from the context with sourceId codex, deterministically", () => {
    const r = map({ ...turnBase, hook_event_name: "UserPromptSubmit", prompt: "hi" });
    expect(r.events).toEqual([
      {
        schemaVersion: 1,
        projectId: "proj-1",
        sourceId: "codex",
        sourceEventId: "e-1:session.prompt_submitted",
        occurredAt: "2026-11-08T12:00:00.000Z",
        agentId: sessionAgentId(SID),
        sessionId: SID,
        type: "session.prompt_submitted",
        payload: {},
        provenance: "live",
        late: false,
      },
    ]);
    expect(map({ ...turnBase, hook_event_name: "UserPromptSubmit", prompt: "hi" })).toEqual(r);
  });

  it("derives agent ids that cannot collide with Claude Code ids", () => {
    expect(sessionAgentId(SID)).toBe(`codex:${SID}`);
    expect(subagentAgentId(SID, CHILD)).toBe(`codex:${SID}:${CHILD}`);
    expect(requestIdFor("e-1")).toBe("codex:request:e-1");
  });

  it("carries late through to every event", () => {
    const r = map({ ...base, hook_event_name: "SessionStart", source: "startup" }, { late: true });
    expect(r.events.length).toBeGreaterThan(0);
    expect(r.events.every((e) => e.late)).toBe(true);
  });

  it("ignores payloads without a usable session_id or hook name", () => {
    expect(map({ hook_event_name: "Stop" }).events).toEqual([]);
    expect(map({ ...base, session_id: "a:b", hook_event_name: "Stop" }).events).toEqual([]);
    expect(map({ ...base }).events).toEqual([]);
    expect(map("nope").events).toEqual([]);
    expect(map({ ...base, hook_event_name: "PreModelRequest" }).events).toEqual([]);
    expect(map({ ...base, hook_event_name: "PreModelRequest" }).ignored).toEqual(
      expect.any(String),
    );
  });

  it("refuses a sourceEventId that leaves no room for the per-event suffix", () => {
    const r = map({ ...turnBase, hook_event_name: "Stop" }, { sourceEventId: "x".repeat(181) });
    expect(r.events).toEqual([]);
  });
});

describe("session lifecycle", () => {
  it("maps SessionStart to the main agent and session.started with the working directory", () => {
    const r = map({ ...base, hook_event_name: "SessionStart", source: "startup" });
    expect(types(r)).toEqual(["agent.registered", "session.started"]);
    expect(only(r, "session.started").payload).toEqual({ workingDirectory: "/tmp/s5-run/proj" });
    const registered = only(r, "agent.registered");
    expect(registered.payload).toMatchObject({ sourceAgentId: SID, kind: "session" });
    expect(registered.agentId).toBe(sessionAgentId(SID));
    expect(new Set(r.events.map((e) => e.sourceEventId)).size).toBe(2);
  });

  it("names the main agent after the owner, never the project directory", () => {
    const r = map(
      { ...base, hook_event_name: "SessionStart", source: "startup" },
      { ownerName: "jack" },
    );
    expect(only(r, "agent.registered").payload.displayName).toBe("jack");
    expect(JSON.stringify(only(r, "agent.registered"))).not.toContain("proj");
  });

  it.each(["resume", "clear", "fork"])("treats source %s as a session start", (source) => {
    expect(types(map({ ...base, hook_event_name: "SessionStart", source }))).toContain(
      "session.started",
    );
  });

  it("does not start a new session for a compact source", () => {
    const r = map({ ...base, hook_event_name: "SessionStart", source: "compact" });
    expect(types(r)).not.toContain("session.started");
  });

  it("maps SessionEnd to session.ended with the reason as outcome", () => {
    const r = map({ ...base, hook_event_name: "SessionEnd", reason: "other" });
    expect(types(r)).toEqual(["session.ended"]);
    expect(only(r, "session.ended").payload).toEqual({ outcome: "other" });
  });

  it("ignores a SessionEnd for a session the engine never saw start", () => {
    const r = map(
      { ...base, hook_event_name: "SessionEnd", reason: "other" },
      { knownSession: false },
    );
    expect(r.events).toEqual([]);
    expect(r.ignored).toEqual(expect.any(String));
  });

  it("maps UserPromptSubmit without copying the prompt", () => {
    const r = map({ ...turnBase, hook_event_name: "UserPromptSubmit", prompt: "secret plan" });
    expect(types(r)).toEqual(["session.prompt_submitted"]);
    expect(JSON.stringify(r)).not.toContain("secret plan");
  });

  it("maps Stop to turn_ended and activity.ended, without the final message", () => {
    const r = map({
      ...turnBase,
      hook_event_name: "Stop",
      stop_hook_active: false,
      last_assistant_message: "private answer",
    });
    expect(types(r)).toEqual(["session.turn_ended", "activity.ended"]);
    expect(JSON.stringify(r)).not.toContain("private answer");
  });

  it("maps Interrupt to a turn ended as interrupted plus activity.ended", () => {
    const r = map({ ...turnBase, hook_event_name: "Interrupt", permission_mode: "default" });
    expect(types(r)).toEqual(["session.turn_failed", "activity.ended"]);
    expect(only(r, "session.turn_failed").payload).toEqual({ reason: "interrupted" });
  });

  it("closes the open tool calls of the interrupted turn as returned, no result claimed", () => {
    const r = map(
      { ...turnBase, hook_event_name: "Interrupt" },
      {
        openToolCalls: [
          { toolCallId: "call_a", turnId: TURN },
          { toolCallId: "call_b", turnId: TURN },
          { toolCallId: "call_other_turn", turnId: "another-turn" },
        ],
      },
    );
    const finished = all(r, "tool_call.finished");
    expect(finished.map((e) => e.payload.toolCallId).sort()).toEqual(["call_a", "call_b"]);
    for (const e of finished) {
      expect(e.payload.phase).toBe("returned");
      expect(e.payload).not.toHaveProperty("durationMs");
      expect(e.agentId).toBe(sessionAgentId(SID));
    }
    expect(new Set(r.events.map((e) => e.sourceEventId)).size).toBe(r.events.length);
  });

  it("attributes an interrupted subagent call to that subagent", () => {
    const r = map(
      { ...turnBase, hook_event_name: "Interrupt" },
      { openToolCalls: [{ toolCallId: "call_c", turnId: TURN, sourceAgentId: CHILD }] },
    );
    expect(only(r, "tool_call.finished").agentId).toBe(subagentAgentId(SID, CHILD));
  });

  it("emits no tool_call.finished on an Interrupt with nothing open", () => {
    const r = map({ ...turnBase, hook_event_name: "Interrupt" }, { openToolCalls: [] });
    expect(types(r)).not.toContain("tool_call.finished");
  });
});

describe("tool calls", () => {
  it("maps a Bash PreToolUse to tool_call.started with the first command line as summary", () => {
    const r = map(pre("Bash", { command: "ls && cat greet.py\necho second line" }));
    expect(only(r, "tool_call.started").payload).toEqual({
      toolCallId: "call_abc123",
      toolName: "Bash",
      summary: "ls && cat greet.py",
    });
    expect(only(r, "tool_call.started").agentId).toBe(sessionAgentId(SID));
  });

  it("keeps the Bash command out of everything but the summary line", () => {
    const r = map(pre("Bash", { command: "echo one\necho hidden-second-line" }));
    expect(JSON.stringify(r)).not.toContain("hidden-second-line");
  });

  it("strips the collaboration prefix from subagent tool names", () => {
    const spawn = map(pre("collaborationspawn_agent", { message: "read README" }));
    expect(only(spawn, "tool_call.started").payload.toolName).toBe("spawn_agent");
    const wait = map(pre("collaborationwait_agent", {}));
    expect(only(wait, "tool_call.started").payload.toolName).toBe("wait_agent");
  });

  it("takes apply_patch filePaths from every patch header", () => {
    const patch = [
      "*** Begin Patch",
      "*** Add File: /tmp/s5-run/proj/new.py",
      "+print(1)",
      "*** Update File: /tmp/s5-run/proj/greet.py",
      "*** Move to: /tmp/s5-run/proj/hello.py",
      "@@",
      "-a",
      "+b",
      "*** Delete File: /tmp/s5-run/proj/old.py",
      "*** End Patch",
    ].join("\n");
    const r = map(pre("apply_patch", { command: patch }));
    expect(only(r, "tool_call.started").payload.filePaths).toEqual([
      "/tmp/s5-run/proj/new.py",
      "/tmp/s5-run/proj/greet.py",
      "/tmp/s5-run/proj/hello.py",
      "/tmp/s5-run/proj/old.py",
    ]);
    expect(JSON.stringify(r)).not.toContain("print(1)");
  });

  it("gives a Bash call no filePaths", () => {
    const r = map(pre("Bash", { command: "ls" }));
    expect(only(r, "tool_call.started").payload).not.toHaveProperty("filePaths");
  });

  it.each([
    [
      "apply_patch",
      { command: "*** Begin Patch\n*** Add File: /a/b.py\n*** End Patch" },
      "implementing",
    ],
    ["collaborationspawn_agent", { message: "x" }, "dispatching"],
    ["mcp__docs__search", { q: "x" }, "researching"],
  ])("starts the %s activity", (tool, input, activity) => {
    const r = map(pre(tool, input));
    expect(types(r)).toEqual(["tool_call.started", "activity.started"]);
    expect(only(r, "activity.started").payload).toMatchObject({ activity });
  });

  it("flags a Bash test run as the heuristic testing activity", () => {
    const r = map(pre("Bash", { command: "pnpm test" }));
    expect(only(r, "activity.started").payload).toEqual({
      activity: "testing",
      heuristic: true,
    });
  });

  it("starts no activity for a plain Bash command", () => {
    expect(types(map(pre("Bash", { command: "ls" })))).toEqual(["tool_call.started"]);
  });

  it("ignores a tool hook without a usable tool_use_id or tool_name", () => {
    expect(map(pre("Bash", { command: "ls" }, { tool_use_id: undefined })).events).toEqual([]);
    expect(map(pre("Bash", { command: "ls" }, { tool_use_id: "a b" })).events).toEqual([]);
    expect(map(pre("Bash", { command: "ls" }, { tool_name: undefined })).events).toEqual([]);
  });

  it("maps PostToolUse to finished with phase returned, never succeeded", () => {
    const r = map({
      ...turnBase,
      hook_event_name: "PostToolUse",
      tool_name: "Bash",
      tool_input: { command: "curl -s http://127.0.0.1:1/" },
      tool_use_id: "call_abc123",
      tool_response: "",
    });
    expect(types(r)).toEqual(["tool_call.finished"]);
    expect(only(r, "tool_call.finished").payload).toEqual({
      toolCallId: "call_abc123",
      phase: "returned",
    });
  });

  it("never claims success even when apply_patch output says Exit code 0", () => {
    const r = map({
      ...turnBase,
      hook_event_name: "PostToolUse",
      tool_name: "apply_patch",
      tool_input: { command: "*** Begin Patch\n*** Update File: /a.py\n*** End Patch" },
      tool_use_id: "call_p",
      tool_response: "Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated.\n",
    });
    expect(only(r, "tool_call.finished").payload.phase).toBe("returned");
    expect(JSON.stringify(r)).not.toContain("succeeded");
  });

  it("pairs Pre and Post through the same toolCallId, and a lone Post still maps", () => {
    const started = only(map(pre("Bash", { command: "ls" })), "tool_call.started");
    const finished = only(
      map({
        ...turnBase,
        hook_event_name: "PostToolUse",
        tool_name: "Bash",
        tool_use_id: "call_abc123",
        tool_response: "x",
      }),
      "tool_call.finished",
    );
    expect(finished.payload.toolCallId).toBe(started.payload.toolCallId);
  });

  it("attributes a subagent's tool call to the subagent", () => {
    const r = map(pre("Bash", { command: "head -1 README.md" }, { agent_id: CHILD }));
    expect(only(r, "tool_call.started").agentId).toBe(subagentAgentId(SID, CHILD));
    expect(only(r, "tool_call.started").sessionId).toBe(SID);
  });
});

describe("permission requests", () => {
  const request = {
    ...turnBase,
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: {
      command: "curl -s -X POST http://127.0.0.1:47805/ping",
      description: "May I run the POST request outside the network sandbox?",
    },
  };

  it("opens a permission request previewing the command, with the model's reason", () => {
    const r = map(request, { sourceEventId: "perm-7" });
    expect(types(r)).toEqual(["request.opened"]);
    expect(only(r, "request.opened").payload).toMatchObject({
      requestId: requestIdFor("perm-7"),
      kind: "permission",
      toolName: "Bash",
      inputPreview: "curl -s -X POST http://127.0.0.1:47805/ping",
      reason: "May I run the POST request outside the network sandbox?",
    });
  });

  it("derives the request id from the sourceEventId, since there is no tool_use_id", () => {
    const a = only(map(request, { sourceEventId: "perm-1" }), "request.opened");
    const b = only(map(request, { sourceEventId: "perm-2" }), "request.opened");
    expect(a.payload.requestId).not.toBe(b.payload.requestId);
    expect(a.agentId).toBe(sessionAgentId(SID));
  });

  it("opens a request without a reason when the hook has no description", () => {
    const r = map({ ...request, tool_input: { command: "ls" } });
    expect(only(r, "request.opened").payload).not.toHaveProperty("reason");
  });
});

describe("subagents", () => {
  const start = {
    ...turnBase,
    hook_event_name: "SubagentStart",
    agent_id: CHILD,
    agent_type: "default",
  };

  it("registers the subagent under the main agent and connects it", () => {
    const r = map(start);
    expect(types(r)).toEqual(["agent.registered", "agent.connected"]);
    const registered = only(r, "agent.registered");
    expect(registered.payload).toMatchObject({
      sourceAgentId: CHILD,
      kind: "subagent",
      role: "default",
      parentAgentId: sessionAgentId(SID),
    });
    expect(registered.agentId).toBe(subagentAgentId(SID, CHILD));
    expect(only(r, "agent.connected").agentId).toBe(subagentAgentId(SID, CHILD));
    expect(registered.sessionId).toBe(SID);
    expect(new Set(r.events.map((e) => e.sourceEventId)).size).toBe(2);
  });

  it("shows the subagent by a short form of its agent_id, never a spawn-order name", () => {
    const name = String(only(map(start), "agent.registered").payload.displayName);
    expect(name.length).toBeGreaterThan(0);
    expect(name.length).toBeLessThan(CHILD.length);
    expect(name).not.toBe("default");
    expect(
      CHILD.includes(name) || name.includes(CHILD.slice(0, 8)) || name.includes(CHILD.slice(-8)),
    ).toBe(true);
    expect(name).not.toMatch(/readme|subagent 1|agent 1|#1/i);
  });

  it("does not claim the subagent is heuristic or named from a spawn", () => {
    const registered = only(map(start), "agent.registered");
    expect(registered.payload.heuristic).not.toBe(true);
  });

  it("maps SubagentStop to agent.finished without copying the final message", () => {
    const r = map({
      ...turnBase,
      hook_event_name: "SubagentStop",
      agent_id: CHILD,
      agent_type: "default",
      stop_hook_active: false,
      last_assistant_message: "private subagent answer",
      agent_transcript_path: "~/.codex/sessions/child.jsonl",
    });
    expect(types(r)).toEqual(["agent.finished"]);
    expect(only(r, "agent.finished").agentId).toBe(subagentAgentId(SID, CHILD));
    expect(JSON.stringify(r)).not.toContain("child.jsonl");
  });

  it("ignores SubagentStart and SubagentStop without an agent_id", () => {
    expect(map({ ...turnBase, hook_event_name: "SubagentStart" }).events).toEqual([]);
    expect(map({ ...turnBase, hook_event_name: "SubagentStop" }).events).toEqual([]);
  });

  it("leaves session lifecycle hooks from inside a subagent unmapped", () => {
    expect(map({ ...turnBase, hook_event_name: "Stop", agent_id: CHILD }).events).toEqual([]);
  });
});
