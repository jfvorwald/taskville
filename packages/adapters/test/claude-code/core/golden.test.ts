import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseInputEvent, producerPolicyViolation } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { type MapResult, mapCoreHook } from "../../../src/claude-code/index.ts";

// Golden tests (M2.03 Done when): each recorded hook stream from spikes S-1 and S-2 maps to the
// event list in __golden__/<stream>.txt. Regenerate with `vitest -u` and review the diff by
// hand. The goldens restate the mapper, so the invariants below check them against facts read
// straight from the fixtures, independently of the mapper (L-21).

const FIXTURES = join(import.meta.dirname, "..", "..", "..", "..", "..", "fixtures", "claude-code");
const BASE_MS = Date.parse("2026-10-30T12:00:00.000Z");

interface Hook {
  seq: number;
  receivedAt: string;
  input: Record<string, unknown>;
}

const readJsonl = (file: string): Record<string, unknown>[] =>
  readFileSync(join(FIXTURES, file), "utf8")
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as Record<string, unknown>);

/** S-2 recorder format: `{ seq, offset_ms, input }`. */
const recorderStream = (file: string): Hook[] =>
  readJsonl(file).map((line) => ({
    seq: line.seq as number,
    receivedAt: new Date(BASE_MS + Math.round(line.offset_ms as number)).toISOString(),
    input: line.input as Record<string, unknown>,
  }));

/** S-1 spike server log: the bodies of its hook requests. */
const serverLogStream = (file: string): Hook[] =>
  readJsonl(file)
    .filter((line) => line.kind === "request" && typeof line.body === "object")
    .map((line) => ({
      seq: line.id as number,
      receivedAt: line.ts as string,
      input: line.body as Record<string, unknown>,
    }));

const STREAMS: Record<string, Hook[]> = {
  "subagent-parallel": recorderStream("subagent/parallel.jsonl"),
  "subagent-nested": recorderStream("subagent/nested.jsonl"),
  "team-in-process": recorderStream("team/in-process.jsonl"),
  "team-split-pane": recorderStream("team/split-pane.jsonl"),
  "team-split-pane-speculative": recorderStream("team/split-pane-speculative.jsonl"),
  "permission-server-log": serverLogStream("permission/server-log.jsonl"),
};

function mapStream(name: string, hooks: Hook[], late = false): MapResult[] {
  return hooks.map((h) =>
    mapCoreHook(h.input, {
      projectId: "proj-1",
      sourceEventId: `${name}-${h.seq}`,
      receivedAt: h.receivedAt,
      late,
    }),
  );
}

const label = (input: Record<string, unknown>): string =>
  [input.hook_event_name, input.notification_type ?? input.tool_name]
    .filter((x) => typeof x === "string")
    .join(":");

/** Readable golden: each hook, then its events (agent, type, payload) and evidence keys. */
function render(hooks: Hook[], results: MapResult[]): string {
  const out: string[] = [];
  hooks.forEach((h, i) => {
    const r = results[i] as MapResult;
    out.push(
      `#${h.seq} ${label(h.input)}${r.ignored === undefined ? "" : `  (ignored: ${r.ignored})`}`,
    );
    for (const e of r.events) {
      const corr = e.correlationId === undefined ? "" : ` corr=${e.correlationId}`;
      out.push(`  ${e.type} ${e.agentId} ${e.sessionId}${corr} ${JSON.stringify(e.payload)}`);
    }
    for (const ev of r.evidence ?? []) {
      const keys = ["input", "output"].filter((k) => Object.hasOwn(ev, k));
      out.push(`  evidence ${ev.toolCallId} ${keys.join("+")}`);
    }
  });
  return `${out.join("\n")}\n`;
}

describe.each(Object.entries(STREAMS))("%s", (name, hooks) => {
  const results = mapStream(name, hooks);
  const events = results.flatMap((r) => r.events);
  const hookIds = (event: string) =>
    hooks
      .filter((h) => h.input.hook_event_name === event)
      .map((h) => h.input.tool_use_id as string);
  const callIds = (type: string, phase?: string) =>
    events
      .filter((e) => e.type === type)
      .map((e) => e.payload as { toolCallId: string; phase?: string })
      .filter((p) => phase === undefined || p.phase === phase)
      .map((p) => p.toolCallId);

  it("has hooks to map", () => {
    expect(hooks.length).toBeGreaterThan(0);
  });

  it("matches the golden event list", async () => {
    await expect(render(hooks, results)).toMatchFileSnapshot(`__golden__/${name}.txt`);
  });

  it("emits only valid protocol v1 events a producer may send", () => {
    for (const e of events) {
      const parsed = parseInputEvent(e);
      expect(parsed, JSON.stringify(e)).toMatchObject({ ok: true });
      if (parsed.ok) expect(producerPolicyViolation(parsed.event)).toBeUndefined();
    }
  });

  it("gives every event a unique sourceEventId", () => {
    const ids = events.map((e) => e.sourceEventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("maps the same stream to the same events every time", () => {
    expect(mapStream(name, hooks)).toEqual(results);
  });

  it("opens one ToolCall per PreToolUse, keyed by its tool_use_id", () => {
    expect(callIds("tool_call.started")).toEqual(hookIds("PreToolUse"));
  });

  it("closes ToolCalls from PostToolUse as succeeded and PostToolUseFailure as failed", () => {
    expect(callIds("tool_call.finished", "succeeded")).toEqual(hookIds("PostToolUse"));
    expect(callIds("tool_call.finished", "failed")).toEqual(hookIds("PostToolUseFailure"));
  });

  it("keeps tool evidence identical to the raw input and output", () => {
    hooks.forEach((h, i) => {
      for (const ev of results[i]?.evidence ?? []) {
        if (h.input.hook_event_name === "PreToolUse") expect(ev.input).toBe(h.input.tool_input);
        if (h.input.hook_event_name === "PostToolUse") {
          expect(ev.output).toBe(h.input.tool_response);
        }
      }
    });
  });

  it("opens a telemetry request for each permission_prompt notification only", () => {
    const prompts = hooks.filter(
      (h) =>
        h.input.hook_event_name === "Notification" &&
        h.input.notification_type === "permission_prompt",
    );
    const opened = events.filter((e) => e.type === "request.opened");
    expect(opened).toHaveLength(prompts.length);
    for (const e of opened) expect(e.payload).toMatchObject({ kind: "permission" });
  });

  it("marks every event late when replayed from the spool, so none can open needs-you", () => {
    const late = mapStream(name, hooks, true).flatMap((r) => r.events);
    expect(late.length).toBe(events.length);
    for (const e of late) expect(e.late).toBe(true);
  });

  it("attributes hooks with agent_id to that agent and others to the session's agent", () => {
    hooks.forEach((h, i) => {
      const sid = h.input.session_id as string;
      const aid = h.input.agent_id;
      const expected = typeof aid === "string" ? `claude-code:${sid}:${aid}` : `claude-code:${sid}`;
      for (const e of results[i]?.events ?? []) {
        expect(e.agentId).toBe(expected);
        expect(e.sessionId).toBe(sid);
      }
    });
  });
});

describe("recorded facts the mapper must preserve (S-1, S-2)", () => {
  const unfinished = (name: string) => {
    const events = mapStream(name, STREAMS[name] as Hook[]).flatMap((r) => r.events);
    const ids = (type: string) =>
      new Set(
        events
          .filter((e) => e.type === type)
          .map((e) => (e.payload as { toolCallId: string }).toolCallId),
      );
    const finished = ids("tool_call.finished");
    return [...ids("tool_call.started")].filter((id) => !finished.has(id));
  };

  it("leaves the helper agent's Pre-only Bash call running (split-pane speculative)", () => {
    const pre = (STREAMS["team-split-pane-speculative"] as Hook[]).find(
      (h) =>
        h.input.hook_event_name === "PreToolUse" &&
        (h.input.tool_input as { command?: string }).command === 'echo "waiting for teammates"',
    );
    expect(pre).toBeDefined();
    expect(unfinished("team-split-pane-speculative")).toEqual([pre?.input.tool_use_id]);
  });

  it("leaves the three denied Bash calls running (S-1 exp5, exp6, exp7 fire no Post)", () => {
    // exp5: the hook denied; exp6 and exp7: terminal No. Nothing follows the PreToolUse.
    expect(unfinished("permission-server-log")).toHaveLength(3);
  });

  it("closes every other recorded call", () => {
    for (const name of [
      "subagent-parallel",
      "subagent-nested",
      "team-in-process",
      "team-split-pane",
    ]) {
      expect(unfinished(name), name).toEqual([]);
    }
  });

  it("maps the one failing Bash call in subagent/parallel to phase failed", () => {
    const events = mapStream("subagent-parallel", STREAMS["subagent-parallel"] as Hook[]).flatMap(
      (r) => r.events,
    );
    const failed = events.filter(
      (e) => e.type === "tool_call.finished" && (e.payload as { phase: string }).phase === "failed",
    );
    expect(failed).toHaveLength(1);
    expect(failed[0]?.payload).toMatchObject({ summary: "Exit code 1", durationMs: 26 });
  });
});
