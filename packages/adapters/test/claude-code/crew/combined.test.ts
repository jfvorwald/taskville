import { parseInputEvent, producerPolicyViolation } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { mapClaudeCodeHook } from "../../../src/claude-code/index.ts";
import { PROJECT, readFixture } from "./replay.ts";

// The adapter entry point the engine calls: core events, then crew events, for each hook.

const STREAMS = [
  "subagent/nested",
  "subagent/parallel",
  "team/in-process",
  "team/split-pane",
  "team/split-pane-speculative",
] as const;

describe.each(STREAMS)("mapClaudeCodeHook over %s", (name) => {
  const results = readFixture(name).map((line) => ({
    line,
    result: mapClaudeCodeHook(line.input, {
      projectId: PROJECT,
      sourceEventId: line.sourceEventId,
      receivedAt: line.receivedAt,
      late: false,
    }),
  }));
  const events = results.flatMap((r) => r.result.events);

  it("emits only valid events a producer may send, with unique sourceEventIds", () => {
    for (const e of events) {
      const parsed = parseInputEvent(e);
      expect(parsed, JSON.stringify(e)).toMatchObject({ ok: true });
      if (parsed.ok) expect(producerPolicyViolation(parsed.event)).toBeUndefined();
    }
    const ids = events.map((e) => e.sourceEventId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("explains every hook that produced nothing", () => {
    for (const { result } of results) {
      if (result.events.length === 0) expect(result.ignored).toMatch(/^core: .+; crew: .+$/);
      else expect(result.ignored).toBeUndefined();
    }
  });
});

describe("core and crew events for one hook", () => {
  it("a teammate spawn closes the Agent tool call (core) and starts the team (crew)", () => {
    const line = readFixture("team/in-process").find((l) => l.seq === 19);
    if (line === undefined) throw new Error("seq 19 missing");
    const { events, evidence } = mapClaudeCodeHook(line.input, {
      projectId: PROJECT,
      sourceEventId: line.sourceEventId,
      receivedAt: line.receivedAt,
      late: false,
    });
    expect(events.map((e) => e.type)).toEqual([
      "tool_call.finished",
      "team.started",
      "agent.registered",
      "agent.registered",
    ]);
    expect(evidence).toHaveLength(1);
  });
});
