import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapCodexHook, sessionAgentId } from "@taskville/adapters/codex";
import { parseInputEvent, type StoredEnvelope, storedEnvelopeSchemas } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { initialState, type ProjectState, reduce } from "../../src/reducer/index.ts";

// A1.01: the recorded Codex TUI stream (spike S-5), mapped by the real adapter and reduced. A
// denied or interrupted call may never have run, so after an Interrupt it ends `unfinished` (the
// domain closes it on session.turn_failed), never `returned` or `succeeded`. A PostToolUse call
// still ends `returned`.

const FIXTURE = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "codex");
const BASE = Date.parse("2026-11-08T12:00:00.000Z");

interface Hook {
  payload: Record<string, unknown>;
}

const hooks = (name: string): Hook[] =>
  readFileSync(join(FIXTURE, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => ({ payload: (JSON.parse(l) as { payload: Record<string, unknown> }).payload }));

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

/** Maps hooks one by one as the engine will, applying each; `after` sees the state per hook. */
function play(
  list: Hook[],
  after: (hook: Hook, state: ProjectState) => void = () => {},
): ProjectState {
  let state = initialState("p1");
  let sequence = 0;
  const known = new Set<string>();
  // What the engine records per call: its turn and, inside a subagent, the hook agent_id.
  const turns = new Map<string, { turnId?: string; sourceAgentId?: string }>();
  list.forEach((hook, index) => {
    const sessionId = String(hook.payload.session_id);
    const p = hook.payload;
    if (p.hook_event_name === "PreToolUse") {
      turns.set(String(p.tool_use_id), {
        ...(typeof p.turn_id === "string" ? { turnId: p.turn_id } : {}),
        ...(typeof p.agent_id === "string" ? { sourceAgentId: p.agent_id } : {}),
      });
    }
    const mapped = mapCodexHook(hook.payload, {
      projectId: "p1",
      sourceEventId: `h-${index}`,
      receivedAt: new Date(BASE + index * 1000).toISOString(),
      late: false,
      knownSession: known.has(sessionId),
      openToolCalls: Object.values(state.toolCalls)
        .filter((c) => c.phase === "running")
        .map((c) => ({ toolCallId: c.id, ...(turns.get(c.id) ?? {}) })),
    });
    for (const raw of mapped.events) {
      sequence += 1;
      const stored = store(raw, sequence);
      if (stored.type === "session.started") known.add(sessionId);
      state = reduce(state, stored);
    }
    after(hook, state);
  });
  return state;
}

describe("Codex tui-hooks stream through the reducer", () => {
  const list = hooks("tui-hooks");
  const interruptAt = list.findIndex((h) => h.payload.hook_event_name === "Interrupt");
  const deniedId = String(
    list
      .slice(0, interruptAt)
      .reverse()
      .find((h) => h.payload.hook_event_name === "PreToolUse")?.payload.tool_use_id,
  );

  it("ends the interrupted main-agent call unfinished, never returned or succeeded", () => {
    const phases: string[] = [];
    play(list, (hook, s) => {
      if (hook === list[interruptAt]) phases.push(String(s.toolCalls[deniedId]?.phase));
    });
    expect(phases).toEqual(["unfinished"]);
  });

  it("keeps the interrupted call under the session's main agent", () => {
    let agentId: string | undefined;
    play(list, (hook, s) => {
      if (hook === list[interruptAt]) agentId = s.toolCalls[deniedId]?.agentId;
    });
    expect(agentId).toBe(sessionAgentId(String(list[0]?.payload.session_id)));
  });

  it("still ends a call that got its PostToolUse as returned", () => {
    const post = list.find(
      (h) => h.payload.hook_event_name === "PostToolUse" && h.payload.agent_id === undefined,
    );
    const phases: string[] = [];
    play(list, (hook, s) => {
      if (hook === post) phases.push(String(s.toolCalls[String(post?.payload.tool_use_id)]?.phase));
    });
    expect(phases).toEqual(["returned"]);
  });

  it("never has a call running after a turn ends, and claims no success", () => {
    const seen: string[] = [];
    const ended = ["Stop", "Interrupt", "SessionEnd"];
    play(list, (hook, s) => {
      for (const c of Object.values(s.toolCalls)) seen.push(c.phase);
      if (
        hook.payload.agent_id === undefined &&
        ended.includes(String(hook.payload.hook_event_name))
      ) {
        expect(Object.values(s.toolCalls).filter((c) => c.phase === "running")).toEqual([]);
      }
    });
    expect(seen.length).toBeGreaterThan(0);
    expect(seen).not.toContain("succeeded");
  });
});
