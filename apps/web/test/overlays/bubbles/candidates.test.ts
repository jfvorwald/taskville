import { describe, expect, it } from "vitest";
import { SILENT_THRESHOLD_MS } from "../../../../../packages/domain/src/selectors/index.ts";
import { bubbleCandidates } from "../../../src/overlays/bubbles/candidates.ts";
import { QUIP_VISIBLE_MS } from "../../../src/quips/schedule.ts";

// M4.06 follow-up to roborev 5854: one candidate per agent, taken from the most urgent record
// whose quip window is open now. A record whose window is closed must not hide a later record of
// the same agent. The tool name comes only from the request the record points at.

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

type Rec = Parameters<typeof bubbleCandidates>[0][number];

const needsYou = (agentId: string, requestId: string, sinceMs: number): Rec => ({
  agentId,
  level: "needs_you",
  kind: "permission",
  since: iso(sinceMs),
  requestId,
  heuristic: false,
});

// A non-heuristic trouble record: its quip clock starts at `since`. (Silent trouble is different;
// see the onset tests below.)
const trouble = (agentId: string, sinceMs: number): Rec => ({
  agentId,
  level: "trouble",
  kind: "tool_failures",
  since: iso(sinceMs),
  heuristic: false,
});

// Silent trouble as the domain selector emits it: `since` is the agent's last-seen time.
const silent = (agentId: string, lastSeenMs: number): Rec => ({
  agentId,
  level: "trouble",
  kind: "silent",
  since: iso(lastSeenMs),
  heuristic: true,
});

describe("bubbleCandidates per-agent choice", () => {
  it("yields the open newer record when the agent's older, more urgent record has a closed window", () => {
    // The older record started 20 s ago: its first window is over and the next is 45 s+ away.
    // The newer one started 1 s ago: its first window is open.
    const now = T0;
    const older = needsYou("a1", "req-old", now - 20_000);
    const newer = trouble("a1", now - 1_000);
    const result = bubbleCandidates([older, newer], {}, now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ agentId: "a1", level: "trouble" });
    expect(result[0]?.eventId).toBe(`tool_failures@${newer.since}`);
  });

  it("yields nothing for an agent whose every record has a closed window", () => {
    const now = T0;
    const result = bubbleCandidates(
      [needsYou("a1", "r1", now - 20_000), trouble("a1", now - 30_000)],
      {},
      now,
    );
    expect(result).toEqual([]);
  });

  it("takes the first open record in the given (most urgent first) order", () => {
    const now = T0;
    const first = needsYou("a1", "r-first", now - 1_000);
    const second = trouble("a1", now - 2_000);
    const result = bubbleCandidates([first, second], {}, now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ agentId: "a1", level: "needs_you", eventId: "r-first" });
  });

  it("does not let one agent's closed record affect another agent", () => {
    const now = T0;
    const result = bubbleCandidates(
      [needsYou("a1", "r1", now - 20_000), needsYou("b2", "r2", now - 1_000)],
      {},
      now,
    );
    expect(result.map((c) => c.agentId)).toEqual(["b2"]);
  });

  it("opens a window exactly at the start and closes it after the visible time", () => {
    const rec = needsYou("a1", "r1", T0);
    expect(bubbleCandidates([rec], {}, T0)).toHaveLength(1);
    expect(bubbleCandidates([rec], {}, T0 + QUIP_VISIBLE_MS - 1)).toHaveLength(1);
    expect(bubbleCandidates([rec], {}, T0 + QUIP_VISIBLE_MS)).toEqual([]);
  });
});

describe("bubbleCandidates tool name source", () => {
  it("reads the tool name from the request the record points at", () => {
    const rec = needsYou("a1", "req-1", T0);
    const [c] = bubbleCandidates([rec], { "req-1": { toolName: "Bash" } }, T0 + 500);
    expect(c?.toolName).toBe("Bash");
    expect(c?.eventId).toBe("req-1");
  });

  it("does not use another request's tool name", () => {
    const rec = needsYou("a1", "req-1", T0);
    const [c] = bubbleCandidates([rec], { "req-2": { toolName: "Write" }, "req-1": {} }, T0 + 500);
    expect(c).toBeDefined();
    expect(c?.toolName).toBeUndefined();
  });

  it("gives no tool name when the request is unknown or the record has no request", () => {
    const withMissing = bubbleCandidates([needsYou("a1", "gone", T0)], {}, T0 + 500);
    expect(withMissing[0]?.toolName).toBeUndefined();
    const noRequest = bubbleCandidates(
      [trouble("a1", T0)],
      { "": { toolName: "Bash" }, undefined: { toolName: "Bash" } },
      T0 + 500,
    );
    expect(noRequest[0]?.toolName).toBeUndefined();
  });
});

// roborev 5873 #2: the domain selector emits silent trouble with `since` = the agent's last-seen
// time, but the trouble only exists once the quiet threshold is crossed. The record carries no
// separate onset field, so the onset is `since + SILENT_THRESHOLD_MS` (the constant the domain
// exports). The first quip is scheduled from the onset, so a record that has just become trouble
// shows its bubble now.
describe("bubbleCandidates silent-trouble onset", () => {
  it("shows the bubble for silent trouble that has just crossed the threshold", () => {
    const now = T0;
    const result = bubbleCandidates([silent("a1", now - SILENT_THRESHOLD_MS - 500)], {}, now);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ agentId: "a1", level: "trouble" });
  });

  it("opens the first window exactly at the onset and closes it after the visible time", () => {
    const lastSeen = T0;
    const onset = lastSeen + SILENT_THRESHOLD_MS;
    const rec = silent("a1", lastSeen);
    expect(bubbleCandidates([rec], {}, onset - 1)).toEqual([]);
    expect(bubbleCandidates([rec], {}, onset)).toHaveLength(1);
    expect(bubbleCandidates([rec], {}, onset + QUIP_VISIBLE_MS - 1)).toHaveLength(1);
    expect(bubbleCandidates([rec], {}, onset + QUIP_VISIBLE_MS)).toEqual([]);
  });

  it("shows nothing before the threshold is crossed", () => {
    const now = T0;
    expect(bubbleCandidates([silent("a1", now - 1_000)], {}, now)).toEqual([]);
    expect(bubbleCandidates([silent("a1", now - SILENT_THRESHOLD_MS + 1_000)], {}, now)).toEqual(
      [],
    );
  });

  it("still seeds the event from the record's own kind and since", () => {
    const rec = silent("a1", T0 - SILENT_THRESHOLD_MS - 500);
    const [c] = bubbleCandidates([rec], {}, T0);
    expect(c?.eventId).toBe(`silent@${rec.since}`);
  });

  it("leaves other heuristic records (a heuristic needs-you) on their own since", () => {
    const rec: Rec = { ...needsYou("a1", "r1", T0 - 500), heuristic: true };
    expect(bubbleCandidates([rec], {}, T0)).toHaveLength(1);
  });
});
