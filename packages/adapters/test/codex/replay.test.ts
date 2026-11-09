import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInputEvent, producerPolicyViolation } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import {
  type CodexHookContext,
  mapCodexHook,
  sessionAgentId,
  subagentAgentId,
} from "../../src/codex/index.ts";

// Replays the recorded S-5 hook streams (fixtures/codex) through the mapper one hook at a time,
// in receive order, as the engine will, feeding back the context it would keep: the sessions it
// has seen start and the tool calls it has seen start and not finish.
//

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "fixtures", "codex");
const BASE_MS = Date.UTC(2026, 10, 8, 12, 0, 0);

interface Line {
  index: number;
  payload: Record<string, unknown>;
  receivedAt: string;
  sourceEventId: string;
}

function readFixture(name: string): Line[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l, index) => {
      const { t_ms, payload } = JSON.parse(l) as {
        t_ms: number;
        payload: Record<string, unknown>;
      };
      return {
        index,
        payload,
        receivedAt: new Date(BASE_MS + t_ms).toISOString(),
        sourceEventId: `${name}-${index}`,
      };
    });
}

type Wire = ReturnType<typeof mapCodexHook>["events"][number] & {
  payload: Record<string, unknown>;
};

interface Mapped {
  hook: string;
  payload: Record<string, unknown>;
  events: Wire[];
  ignored?: string;
}

function replay(name: string): Mapped[] {
  const known = new Set<string>();
  const open = new Map<string, { toolCallId: string; turnId?: string; sourceAgentId?: string }>();
  return readFixture(name).map((line) => {
    const p = line.payload;
    const sessionId = String(p.session_id);
    const c: CodexHookContext = {
      projectId: "proj-codex",
      ownerName: "owner",
      sourceEventId: line.sourceEventId,
      receivedAt: line.receivedAt,
      late: false,
      knownSession: known.has(sessionId),
      openToolCalls: [...open.values()],
    };
    const result = mapCodexHook(p, c);
    const events = result.events as Wire[];
    for (const e of events) {
      if (e.type === "session.started") known.add(sessionId);
      if (e.type === "tool_call.started") {
        const id = String(e.payload.toolCallId);
        open.set(id, {
          toolCallId: id,
          ...(typeof p.turn_id === "string" ? { turnId: p.turn_id } : {}),
          ...(typeof p.agent_id === "string" ? { sourceAgentId: p.agent_id } : {}),
        });
      }
      if (e.type === "tool_call.finished") open.delete(String(e.payload.toolCallId));
    }
    return {
      hook: String(p.hook_event_name),
      payload: p,
      events,
      ...(result.ignored === undefined ? {} : { ignored: result.ignored }),
    };
  });
}

const STREAMS = ["tui-hooks", "exec-hooks"] as const;
const flat = (m: Mapped[]) => m.flatMap((x) => x.events);

describe.each(STREAMS)("replay of fixtures/codex/%s", (name) => {
  const mapped = replay(name);

  it("emits events that pass the protocol input schema and producer policy", () => {
    const events = flat(mapped);
    expect(events.length).toBeGreaterThan(0);
    for (const event of events) {
      const parsed = parseInputEvent(event);
      expect(parsed, JSON.stringify(event)).toMatchObject({ ok: true });
      if (parsed.ok) expect(producerPolicyViolation(parsed.event)).toBeUndefined();
    }
  });

  it("uses sourceId codex and unique sourceEventIds", () => {
    const events = flat(mapped);
    expect(events.every((e) => e.sourceId === "codex")).toBe(true);
    const ids = events.map((e) => e.sourceEventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("never claims success: no succeeded phase, only returned", () => {
    const finished = flat(mapped).filter((e) => e.type === "tool_call.finished");
    expect(finished.length).toBeGreaterThan(0);
    expect(finished.every((e) => e.payload.phase === "returned")).toBe(true);
    expect(JSON.stringify(flat(mapped))).not.toContain("succeeded");
  });

  it("gives identical events and ids on a second run", () => {
    expect(replay(name)).toEqual(mapped);
  });

  it("maps every session to one main agent and starts it exactly once", () => {
    const started = flat(mapped).filter((e) => e.type === "session.started");
    expect(started).toHaveLength(1);
    expect(started[0]?.agentId).toBe(sessionAgentId(String(mapped[0]?.payload.session_id)));
    expect(started[0]?.payload.workingDirectory).toBe("/tmp/s5-run/proj");
  });

  it("pairs every tool_call.started with at most one tool_call.finished", () => {
    const events = flat(mapped);
    const started = events.filter((e) => e.type === "tool_call.started");
    const finished = events.filter((e) => e.type === "tool_call.finished");
    const ids = started.map((e) => e.payload.toolCallId);
    expect(new Set(ids).size).toBe(ids.length);
    for (const f of finished) expect(ids).toContain(f.payload.toolCallId);
    expect(new Set(finished.map((f) => f.payload.toolCallId)).size).toBe(finished.length);
  });

  it("emits nothing from the model-request hooks", () => {
    for (const m of mapped) {
      if (m.hook === "PreModelRequest" || m.hook === "PostModelRequest") {
        expect(m.events).toEqual([]);
      }
    }
  });

  it("ends the session once", () => {
    expect(flat(mapped).filter((e) => e.type === "session.ended")).toHaveLength(1);
  });
});

describe("tui-hooks specifics", () => {
  const mapped = replay("tui-hooks");
  const events = flat(mapped);

  it("opens a permission request for each escalated curl", () => {
    const requests = events.filter((e) => e.type === "request.opened");
    expect(requests).toHaveLength(2);
    for (const r of requests) {
      expect(r.payload.kind).toBe("permission");
      expect(String(r.payload.inputPreview)).toContain("curl");
      expect(String(r.payload.reason)).toContain("May I");
    }
  });

  it("turns the Esc on the second prompt into an interrupted turn that finishes no call", () => {
    const at = mapped.findIndex((m) => m.hook === "Interrupt");
    const interrupt = mapped[at] as Mapped;
    expect(interrupt.events.map((e) => e.type)).toEqual(["session.turn_failed", "activity.ended"]);
    const failed = interrupt.events.filter((e) => e.type === "session.turn_failed");
    expect(failed.map((e) => e.payload.reason)).toEqual(["interrupted"]);
    // The denied call was open when the Esc came and never gets a tool_call.finished.
    const pre = mapped
      .slice(0, at)
      .reverse()
      .find((m) => m.hook === "PreToolUse");
    const deniedId = pre?.payload.tool_use_id;
    expect(deniedId).toBeDefined();
    const finishedIds = events
      .filter((e) => e.type === "tool_call.finished")
      .map((e) => e.payload.toolCallId);
    expect(finishedIds).not.toContain(deniedId);
  });

  it("strips the collaboration prefix and registers the subagent under the main agent", () => {
    const names = events
      .filter((e) => e.type === "tool_call.started")
      .map((e) => e.payload.toolName);
    expect(names).toContain("spawn_agent");
    expect(names).toContain("wait_agent");
    expect(names.join(" ")).not.toContain("collaboration");

    const start = mapped.find((m) => m.hook === "SubagentStart") as Mapped;
    const child = String(start.payload.agent_id);
    const sessionId = String(start.payload.session_id);
    const registered = start.events.find((e) => e.type === "agent.registered");
    expect(registered?.agentId).toBe(subagentAgentId(sessionId, child));
    expect(registered?.payload).toMatchObject({
      kind: "subagent",
      parentAgentId: sessionAgentId(sessionId),
    });
    expect(start.events.map((e) => e.type)).toEqual(["agent.registered", "agent.connected"]);

    const stop = mapped.find((m) => m.hook === "SubagentStop") as Mapped;
    expect(stop.events.map((e) => e.type)).toEqual(["agent.finished"]);
  });

  it("attributes the subagent's own tool call to the subagent", () => {
    const sub = mapped.filter((m) => m.hook === "PreToolUse" && m.payload.agent_id !== undefined);
    expect(sub.length).toBeGreaterThan(0);
    for (const m of sub) {
      const sessionId = String(m.payload.session_id);
      expect(m.events[0]?.agentId).toBe(subagentAgentId(sessionId, String(m.payload.agent_id)));
    }
  });
});

describe("exec-hooks specifics", () => {
  const events = flat(replay("exec-hooks"));

  it("records the apply_patch as implementing with its absolute file path", () => {
    const patch = events.find(
      (e) => e.type === "tool_call.started" && e.payload.toolName === "apply_patch",
    );
    expect(patch?.payload.filePaths).toEqual(["/tmp/s5-run/proj/greet.py"]);
    const activities = events.filter((e) => e.type === "activity.started");
    expect(activities.map((e) => e.payload.activity)).toContain("implementing");
  });

  it("summarizes Bash calls by the first command line", () => {
    const summaries = events
      .filter((e) => e.type === "tool_call.started" && e.payload.toolName === "Bash")
      .map((e) => e.payload.summary);
    expect(summaries).toContain("ls && cat greet.py");
  });

  it("opens no permission request in exec mode", () => {
    expect(events.some((e) => e.type === "request.opened")).toBe(false);
  });
});
