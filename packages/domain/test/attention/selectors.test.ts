import { attentionSchema } from "@taskville/protocol";
import { describe, expect, it } from "vitest";
import { stateHash } from "../../src/hash/index.ts";
import {
  initialRequestsState,
  type PendingRequest,
  reduceRequests,
} from "../../src/reducer/attention/index.ts";
import {
  type AttentionAgent,
  type AttentionInput,
  attention,
  attentionCounts,
  needsAttention,
  SILENT_THRESHOLD_MS,
} from "../../src/selectors/index.ts";
import { BRIDGE, deepFreeze, ENGINE, eventStream, reason } from "./envelopes.ts";

const T0 = "2026-10-30T10:00:00Z";
const ms = (iso: string) => Date.parse(iso);
const minutes = (n: number) => n * 60_000;

function agent(id: string, extra: Partial<AttentionAgent> = {}): AttentionAgent {
  return { id, connection: "connected", lastSeenAt: T0, consecutiveToolFailures: 0, ...extra };
}

function stateOf(agents: AttentionAgent[], requests: PendingRequest[] = []): AttentionInput {
  return {
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    requests: Object.fromEntries(requests.map((r) => [r.id, r])),
  };
}

function request(id: string, extra: Partial<PendingRequest> = {}): PendingRequest {
  return {
    id,
    agentId: "a1",
    sessionId: "s1",
    kind: "permission",
    answerable: false,
    openedAt: T0,
    state: "open",
    late: false,
    mergedRequestIds: [],
    ...extra,
  };
}

const now = ms(T0) + minutes(1);

describe("needs_you", () => {
  it("raises one record per open request, carrying its kind, reason, and ID", () => {
    const state = stateOf(
      [agent("a1")],
      [
        request("r1", { toolName: "Bash", reason: reason("touch a.txt") }),
        request("r2", { kind: "elicitation", openedAt: "2026-10-30T10:00:05Z" }),
      ],
    );
    expect(attention(state, now)).toEqual([
      {
        agentId: "a1",
        level: "needs_you",
        kind: "permission",
        reason: reason("touch a.txt"),
        since: T0,
        requestId: "r1",
        heuristic: false,
      },
      {
        agentId: "a1",
        level: "needs_you",
        kind: "elicitation",
        since: "2026-10-30T10:00:05Z",
        requestId: "r2",
        heuristic: false,
      },
    ]);
  });

  it("raises nothing for closed or late requests", () => {
    const state = stateOf(
      [agent("a1")],
      [
        request("r1", { state: "answered_here" }),
        request("r2", { state: "answered_elsewhere" }),
        request("r3", { state: "expired" }),
        request("r4", { state: "expired", late: true }),
        request("r5", { state: "open", late: true }),
      ],
    );
    expect(needsAttention(state)).toEqual([]);
    expect(attention(state, now)).toEqual([]);
  });

  it("shows one red state for a PermissionRequest and its Notification, and none for a late prompt", () => {
    const emit = eventStream();
    const events = [
      emit(
        "request.opened",
        { requestId: "b1", kind: "permission", toolName: "Bash", inputPreview: "touch a" },
        { agentId: "a1", sessionId: "s1", sourceId: BRIDGE },
      ),
      emit(
        "request.opened",
        { requestId: "n1", kind: "permission", toolName: "Bash" },
        { agentId: "a1", sessionId: "s1" },
      ),
      emit(
        "request.opened",
        { requestId: "l1", kind: "permission", toolName: "Bash" },
        { agentId: "a2", sessionId: "s2", late: true },
      ),
    ];
    const { requests } = events.reduce(reduceRequests, initialRequestsState());
    const state = { agents: { a1: agent("a1"), a2: agent("a2") }, requests };
    const records = needsAttention(state);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ agentId: "a1", requestId: "b1", level: "needs_you" });

    const closed = [
      ...events,
      emit(
        "request.resolved",
        { requestId: "n1", resolution: "answered_here" },
        { sourceId: ENGINE },
      ),
    ].reduce(reduceRequests, initialRequestsState());
    expect(needsAttention({ ...state, requests: closed.requests })).toEqual([]);
  });

  it("keeps needs_you for a disconnected agent and for an agent not yet registered", () => {
    const state = stateOf(
      [agent("a1", { connection: "disconnected" })],
      [request("r1"), request("r2", { agentId: "ghost" })],
    );
    expect(needsAttention(state).map((r) => r.agentId)).toEqual(["a1", "ghost"]);
  });
});

describe("trouble and waiting from agent records", () => {
  it("raises stop_failure from a failed latest turn", () => {
    const state = stateOf([
      agent("a1", { lastTurn: "failed", lastTurnAt: "2026-10-30T10:00:30Z" }),
    ]);
    expect(attention(state, now)).toEqual([
      {
        agentId: "a1",
        level: "trouble",
        kind: "stop_failure",
        since: "2026-10-30T10:00:30Z",
        heuristic: false,
      },
    ]);
  });

  it("raises tool_failures at three consecutive failures, not two", () => {
    const two = stateOf([agent("a1", { consecutiveToolFailures: 2 })]);
    expect(attention(two, now)).toEqual([]);
    const three = stateOf([agent("a1", { consecutiveToolFailures: 3 })]);
    expect(attention(three, now)).toEqual([
      { agentId: "a1", level: "trouble", kind: "tool_failures", since: T0, heuristic: false },
    ]);
  });

  it("raises waiting for turn_ended and idle_prompt", () => {
    const state = stateOf([
      agent("a1", { lastTurn: "ended", lastTurnAt: "2026-10-30T10:00:10Z" }),
      agent("a2", { lastTurn: "idle_prompt", lastTurnAt: "2026-10-30T10:00:20Z" }),
    ]);
    expect(attention(state, now)).toEqual([
      {
        agentId: "a1",
        level: "waiting",
        kind: "turn_ended",
        since: "2026-10-30T10:00:10Z",
        heuristic: false,
      },
      {
        agentId: "a2",
        level: "waiting",
        kind: "idle_prompt",
        since: "2026-10-30T10:00:20Z",
        heuristic: false,
      },
    ]);
  });

  it("falls back to lastSeenAt when no turn time is recorded", () => {
    const state = stateOf([agent("a1", { lastTurn: "ended" })]);
    expect(attention(state, now)[0]?.since).toBe(T0);
  });
});

describe("heuristic silent trouble with an injected clock", () => {
  const quiet = agent("a1", { lastSeenAt: T0 });

  it("defaults the threshold to 10 minutes (spec 001)", () => {
    expect(SILENT_THRESHOLD_MS).toBe(600_000);
  });

  it("raises silent only once now - lastSeenAt exceeds the threshold, labelled heuristic", () => {
    const state = stateOf([quiet]);
    expect(attention(state, ms(T0) + minutes(10))).toEqual([]);
    expect(attention(state, ms(T0) + minutes(12))).toEqual([
      {
        agentId: "a1",
        level: "trouble",
        kind: "silent",
        reason: { text: "quiet for 12 min", masked: false, truncated: false },
        since: T0,
        heuristic: true,
      },
    ]);
  });

  it("honours a configured threshold", () => {
    const state = stateOf([quiet]);
    const options = { silentThresholdMs: minutes(2) };
    expect(attention(state, ms(T0) + minutes(3), options)[0]?.kind).toBe("silent");
    expect(attention(state, ms(T0) + minutes(1), options)).toEqual([]);
  });

  it("skips agents that are disconnected, unknown, finished, waiting, or needing you", () => {
    const late = ms(T0) + minutes(30);
    const state = stateOf(
      [
        agent("disc", { connection: "disconnected" }),
        agent("unk", { connection: "unknown" }),
        agent("done", { finishedAt: "2026-10-30T10:00:01Z" }),
        agent("wait", { lastTurn: "ended" }),
        agent("red"),
      ],
      [request("r1", { agentId: "red" })],
    );
    expect(attention(state, late).filter((r) => r.kind === "silent")).toEqual([]);
  });

  it("still applies alongside non-heuristic trouble", () => {
    const state = stateOf([agent("a1", { consecutiveToolFailures: 4 })]);
    expect(attention(state, ms(T0) + minutes(11)).map((r) => r.kind)).toEqual([
      "tool_failures",
      "silent",
    ]);
  });

  it("never stores attention: the state and its hash are unchanged by any clock", () => {
    const state = deepFreeze(
      stateOf([quiet, agent("a2", { lastTurn: "failed" })], [request("r1")]),
    );
    const before = stateHash(1, state);
    for (const t of [now, ms(T0) + minutes(11), ms(T0) + minutes(600)]) attention(state, t);
    expect(stateHash(1, state)).toBe(before);
    expect(Object.keys(state).sort()).toEqual(["agents", "requests"]);
  });
});

describe("ordering, counts, and schema", () => {
  const state = stateOf(
    [
      agent("w1", { lastTurn: "ended", lastTurnAt: "2026-10-30T09:00:00Z" }),
      agent("t1", { lastTurn: "failed", lastTurnAt: "2026-10-30T10:00:02Z" }),
      agent("t2", { consecutiveToolFailures: 5, lastSeenAt: "2026-10-30T11:00:01+02:00" }),
      agent("n1"),
      agent("n2"),
    ],
    [
      request("r1", { agentId: "n1", openedAt: "2026-10-30T10:00:09Z" }),
      request("r2", { agentId: "n2", openedAt: "2026-10-30T12:00:01+03:00" }),
      request("r3", { agentId: "n2", kind: "input", openedAt: "2026-10-30T10:00:20Z" }),
    ],
  );

  // Before every lastSeenAt but t2's, and under 10 minutes after it, so nothing is silent.
  const early = ms("2026-10-30T09:05:00Z");

  it("sorts needs_you, then trouble, then waiting, each by since in real time", () => {
    expect(attention(state, early).map((r) => `${r.level}:${r.agentId}:${r.kind}`)).toEqual([
      "needs_you:n2:permission",
      "needs_you:n1:permission",
      "needs_you:n2:input",
      "trouble:t2:tool_failures",
      "trouble:t1:stop_failure",
      "waiting:w1:turn_ended",
    ]);
  });

  it("returns only needs_you records from needsAttention", () => {
    expect(needsAttention(state).map((r) => r.requestId)).toEqual(["r2", "r1", "r3"]);
  });

  it("counts agents per level, not records", () => {
    expect(attentionCounts(state, early)).toEqual({ needsYou: 2, trouble: 2, waiting: 1 });
    expect(attentionCounts(stateOf([]), now)).toEqual({ needsYou: 0, trouble: 0, waiting: 0 });
  });

  it("counts heuristic silent trouble only when the clock says so", () => {
    const quiet = stateOf([agent("a1")]);
    expect(attentionCounts(quiet, now).trouble).toBe(0);
    expect(attentionCounts(quiet, ms(T0) + minutes(11)).trouble).toBe(1);
  });

  it("emits records the protocol's attention schema accepts", () => {
    const records = attention(state, ms(T0) + minutes(700));
    expect(records.some((r) => r.heuristic)).toBe(true);
    for (const record of records) expect(attentionSchema.parse(record)).toEqual(record);
  });
});
