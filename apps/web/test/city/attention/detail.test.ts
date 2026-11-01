import { describe, expect, it } from "vitest";
import { troubleDetail } from "../../../src/city/attention/detail.ts";
import { type Attention, attention } from "../../../src/data/domain.ts";

// Heuristic trouble ("running but silent") is labeled as a guess with the elapsed minutes. The
// minutes come from the attention selector, which takes an injected clock and generates
// `reason.text` ("quiet for 12 min"); nothing here reads a clock or stores the text. Recorded
// trouble (StopFailure, repeated tool failures) is a fact and is not labeled heuristic.

const MIN = 60_000;
const SEEN = "2026-05-01T10:00:00.000Z";
const SEEN_MS = Date.parse(SEEN);

function agentWith(over: Record<string, unknown> = {}) {
  return {
    id: "a1",
    connection: "connected" as const,
    lastSeenAt: SEEN,
    consecutiveToolFailures: 0,
    ...over,
  };
}

function recordAt(agent: ReturnType<typeof agentWith>, now: number): Attention {
  const found = attention({ agents: { [agent.id]: agent }, requests: {} }, now);
  const first = found[0];
  if (first === undefined) throw new Error("no attention record");
  return first;
}

describe("troubleDetail", () => {
  it("labels silent trouble as a heuristic with the minutes from the injected clock", () => {
    const agent = agentWith();
    expect(troubleDetail(recordAt(agent, SEEN_MS + 12 * MIN))).toEqual({
      text: "quiet for 12 min",
      heuristic: true,
    });
    // The same state read at a later clock gives a later label: nothing is stored.
    expect(troubleDetail(recordAt(agent, SEEN_MS + 15 * MIN))).toEqual({
      text: "quiet for 15 min",
      heuristic: true,
    });
  });

  it("falls back to 'quiet' when a silent record carries no reason text", () => {
    const record: Attention = {
      agentId: "a1",
      level: "trouble",
      kind: "silent",
      since: SEEN,
      heuristic: true,
    };
    expect(troubleDetail(record)).toEqual({ text: "quiet", heuristic: true });
  });

  it("does not label a failed turn as a heuristic", () => {
    const record = recordAt(agentWith({ lastTurn: "failed", lastTurnAt: SEEN }), SEEN_MS + MIN);
    expect(record.kind).toBe("stop_failure");
    expect(troubleDetail(record)).toEqual({ text: "turn failed", heuristic: false });
  });

  it("does not label repeated tool failures as a heuristic", () => {
    const record = recordAt(agentWith({ consecutiveToolFailures: 3 }), SEEN_MS + MIN);
    expect(record.kind).toBe("tool_failures");
    expect(troubleDetail(record)).toEqual({ text: "tool failures", heuristic: false });
  });

  it("has no trouble detail for needs-you or waiting records, or for no record", () => {
    const base = { agentId: "a1", since: SEEN, heuristic: false } as const;
    expect(troubleDetail({ ...base, level: "needs_you", kind: "permission" })).toBeUndefined();
    expect(troubleDetail({ ...base, level: "waiting", kind: "turn_ended" })).toBeUndefined();
    expect(troubleDetail(undefined)).toBeUndefined();
  });
});
