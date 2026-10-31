import { describe, expect, it } from "vitest";
import { initialRequestsState, reduceRequests } from "../../src/reducer/attention/index.ts";
import { type AttentionAgent, attention } from "../../src/selectors/index.ts";
import { BRIDGE, eventStream } from "./envelopes.ts";

// M2.15 (#143): attention orders by exact instant, not Date.parse. Date.parse is only specified
// to millisecond precision, so timestamps that differ below a millisecond tied and fell back to
// ID order. The merge target feeds stateHash, so the order must be exact on every engine.

describe("merge target by exact instant", () => {
  it.each([
    ["sub-millisecond digits", "2026-10-30T10:00:00.0001Z", "2026-10-30T10:00:00.0002Z"],
    [
      "an offset and sub-millisecond digits",
      "2026-10-30T11:00:00.0001+01:00",
      "2026-10-30T10:00:00.0002Z",
    ],
    ["nine fractional digits", "2026-10-30T10:00:00.000000001Z", "2026-10-30T10:00:00.000000002Z"],
  ])("merges into the earliest open request with %s", (_, early, late) => {
    const emit = eventStream();
    // ID order is the opposite of time order, so a tie would pick the wrong record.
    const events = [
      emit(
        "request.opened",
        { requestId: "a-late", kind: "permission", toolName: "Bash" },
        { agentId: "a1", sessionId: "s1", sourceId: BRIDGE, occurredAt: late },
      ),
      emit(
        "request.opened",
        { requestId: "z-early", kind: "permission", toolName: "Bash" },
        { agentId: "a1", sessionId: "s1", sourceId: BRIDGE, occurredAt: early },
      ),
      emit(
        "request.opened",
        { requestId: "t1", kind: "permission", toolName: "Bash" },
        { agentId: "a1", sessionId: "s1" },
      ),
    ];
    const state = events.reduce(reduceRequests, initialRequestsState());
    expect(state.requests["z-early"]?.mergedRequestIds).toEqual(["t1"]);
    expect(state.requests["a-late"]?.mergedRequestIds).toEqual([]);
  });
});

describe("attention order by exact instant", () => {
  const agent = (id: string, lastTurnAt: string): AttentionAgent => ({
    id,
    connection: "connected",
    lastSeenAt: lastTurnAt,
    consecutiveToolFailures: 0,
    lastTurn: "ended",
    lastTurnAt,
  });

  it.each([
    ["sub-millisecond digits", "2026-10-30T10:00:00.0001Z", "2026-10-30T10:00:00.0002Z"],
    ["an offset", "2026-10-30T11:00:00.0001+01:00", "2026-10-30T10:00:00.0002Z"],
  ])("sorts records of one level by since with %s", (_, early, late) => {
    const state = {
      agents: { a: agent("a", late), z: agent("z", early) },
      requests: {},
    };
    const now = Date.parse("2026-10-30T10:01:00Z");
    expect(attention(state, now).map((r) => r.agentId)).toEqual(["z", "a"]);
  });

  it("still measures quiet time against the injected clock", () => {
    const state = {
      agents: {
        q: {
          id: "q",
          connection: "connected" as const,
          lastSeenAt: "2026-10-30T09:00:00.5+00:00",
          consecutiveToolFailures: 0,
        },
      },
      requests: {},
    };
    const now = Date.parse("2026-10-30T10:00:00.5Z");
    expect(attention(state, now)).toMatchObject([
      { agentId: "q", kind: "silent", reason: { text: "quiet for 60 min" }, heuristic: true },
    ]);
  });
});
