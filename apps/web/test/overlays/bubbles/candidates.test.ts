import { describe, expect, it } from "vitest";
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

const trouble = (agentId: string, sinceMs: number): Rec => ({
  agentId,
  level: "trouble",
  kind: "silent",
  since: iso(sinceMs),
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
    expect(result[0]?.eventId).toBe(`silent@${newer.since}`);
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
