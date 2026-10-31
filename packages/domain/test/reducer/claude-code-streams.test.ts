import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapClaudeCodeHook } from "@taskville/adapters/claude-code";
import { parseInputEvent, type StoredEnvelope, storedEnvelopeSchemas } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { initialState, type ProjectState, reduce } from "../../src/reducer/index.ts";

// M2.13 Done when: recorded Claude Code streams (spikes S-1 and S-2), mapped by the real adapter,
// leave no ToolCall running once the turn ends, and a stream that starts mid-session with a
// subagent's tool call still gives the session to the lead.

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "claude-code");
const BASE = Date.parse("2026-10-30T12:00:00.000Z");

interface Hook {
  seq: number;
  input: Record<string, unknown>;
}

const lines = (file: string) =>
  readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Record<string, unknown>);

const recorder = (file: string): Hook[] =>
  lines(file).map((l) => ({ seq: l.seq as number, input: l.input as Record<string, unknown> }));

const serverLog = (): Hook[] =>
  lines("permission/server-log.jsonl")
    .filter((l) => l.kind === "request" && typeof l.body === "object")
    .map((l) => ({ seq: l.id as number, input: l.body as Record<string, unknown> }));

/** What the engine stores: parsed, reason in its stored form, engine fields added. */
function store(raw: unknown, sequence: number): StoredEnvelope {
  const parsed = parseInputEvent(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  const event = parsed.event as StoredEnvelope & { payload: Record<string, unknown> };
  const payload =
    typeof event.payload.reason === "string"
      ? {
          ...event.payload,
          reason: { text: event.payload.reason.slice(0, 280), masked: false, truncated: false },
        }
      : event.payload;
  return storedEnvelopeSchemas[event.type].parse({
    ...event,
    payload,
    eventId: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
    receivedAt: event.occurredAt,
    ingestSequence: sequence,
  }) as StoredEnvelope;
}

/** Maps and applies hooks one by one, calling `after` with the state after each hook. */
function play(
  hooks: Hook[],
  after: (hook: Hook, state: ProjectState) => void = () => {},
): ProjectState {
  let state = initialState("p1");
  let sequence = 0;
  for (const hook of hooks) {
    const mapped = mapClaudeCodeHook(hook.input, {
      projectId: "p1",
      sourceEventId: `h-${hook.seq}`,
      receivedAt: new Date(BASE + sequence * 1000).toISOString(),
      late: false,
    });
    for (const raw of mapped.events) {
      sequence += 1;
      state = reduce(state, store(raw, sequence));
    }
    after(hook, state);
  }
  return state;
}

const running = (state: ProjectState) =>
  Object.values(state.toolCalls).filter((c) => c.phase === "running");
const isMainAgentHook = (h: Hook) => !Object.hasOwn(h.input, "agent_id");
const isTurnEnd = (h: Hook) =>
  isMainAgentHook(h) &&
  (h.input.hook_event_name === "Stop" || h.input.hook_event_name === "UserPromptSubmit");

describe("S-1 permission log: denied calls fire no PostToolUse", () => {
  it("leaves no call running after each turn ends, and the denied ones unfinished", () => {
    const afterTurns: number[] = [];
    const state = play(serverLog(), (hook, s) => {
      if (isTurnEnd(hook)) afterTurns.push(running(s).length);
    });
    expect(afterTurns.length).toBeGreaterThan(0);
    expect(afterTurns.every((n) => n === 0)).toBe(true);
    expect(running(state)).toEqual([]);
    expect(Object.values(state.toolCalls).some((c) => c.phase === "succeeded")).toBe(true);
  });

  it("closes the three denied calls as unfinished, never succeeded", () => {
    const hooks = serverLog();
    const pre = hooks.filter((h) => h.input.hook_event_name === "PreToolUse");
    const posted = new Set(
      hooks
        .filter((h) => h.input.hook_event_name === "PostToolUse")
        .map((h) => h.input.tool_use_id),
    );
    const denied = pre.map((h) => h.input.tool_use_id as string).filter((id) => !posted.has(id));
    expect(denied).toHaveLength(3);
    const outcomes: Record<string, string> = {};
    play(hooks, (_, s) => {
      for (const id of denied) {
        const call = s.toolCalls[id];
        if (call !== undefined) outcomes[id] = call.phase;
      }
    });
    expect(Object.values(outcomes)).toEqual(["unfinished", "unfinished", "unfinished"]);
  });
});

describe("S-2 split-pane speculative: the helper agent's Pre-only call", () => {
  const hooks = recorder("team/split-pane-speculative.jsonl");
  const helperPre = hooks.find(
    (h) =>
      h.input.hook_event_name === "PreToolUse" &&
      (h.input.tool_input as { command?: string }).command === 'echo "waiting for teammates"',
  );

  it("is not running once its session's turn ends", () => {
    expect(helperPre).toBeDefined();
    const id = helperPre?.input.tool_use_id as string;
    const session = helperPre?.input.session_id;
    let seen = false;
    let checked = false;
    play(hooks, (hook, s) => {
      if (hook === helperPre) seen = true;
      if (seen && !checked && isTurnEnd(hook) && hook.input.session_id === session) {
        checked = true;
        expect(s.toolCalls[id]?.phase).toBe("unfinished");
      }
    });
    expect(checked).toBe(true);
  });

  it("leaves no call running at the end of the stream", () => {
    expect(running(play(hooks))).toEqual([]);
  });
});

describe("a stream that starts mid-session with a subagent's tool call", () => {
  it("still gives the session, and its turn events, to the lead", () => {
    const all = recorder("subagent/parallel.jsonl");
    const firstSub = all.findIndex(
      (h) => h.input.hook_event_name === "PreToolUse" && Object.hasOwn(h.input, "agent_id"),
    );
    expect(firstSub).toBeGreaterThan(0);
    const sid = all[0]?.input.session_id as string;
    const lead = `claude-code:${sid}`;
    let leadTurnEnded = false;
    const state = play(all.slice(firstSub), (hook, s) => {
      if (hook.input.hook_event_name === "Stop" && isMainAgentHook(hook)) {
        leadTurnEnded ||= s.agents[lead]?.lastTurn === "ended";
      }
    });
    expect(state.sessions[sid]?.agentId).toBe(lead);
    expect(state.sessions[sid]?.endedAt).toBeDefined();
    expect(leadTurnEnded).toBe(true);
  });
});
