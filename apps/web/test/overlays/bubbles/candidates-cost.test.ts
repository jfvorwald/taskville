import { beforeEach, describe, expect, it, vi } from "vitest";
import { bubbleCandidates } from "../../../src/overlays/bubbles/candidates.ts";
import * as schedule from "../../../src/quips/schedule.ts";

// roborev 5873 #3: a waiting record only ever shows a bubble for the selected agent, so an
// unselected waiting record must be dropped before any scheduling work. Persisted waiting records
// can be months old; the overlay re-checks every 500 ms. The seam is `quipVisibleAt` (the one
// scheduling call, reached through `quips/schedule.ts` or its `quips/index.ts` re-export), and the
// fourth argument of `bubbleCandidates` is the selected agent ID, as in `SelectOptions`.

vi.mock("../../../src/quips/schedule.ts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../../src/quips/schedule.ts")>();
  return { ...actual, quipVisibleAt: vi.fn(actual.quipVisibleAt) };
});

const T0 = Date.parse("2026-11-01T10:00:00.000Z");
const iso = (ms: number) => new Date(ms).toISOString();

type Rec = Parameters<typeof bubbleCandidates>[0][number];

const waiting = (agentId: string, sinceMs: number): Rec => ({
  agentId,
  level: "waiting",
  kind: "turn_ended",
  since: iso(sinceMs),
  heuristic: false,
});

const needsYou = (agentId: string, sinceMs: number): Rec => ({
  agentId,
  level: "needs_you",
  kind: "permission",
  since: iso(sinceMs),
  requestId: `req-${agentId}`,
  heuristic: false,
});

const visibleSpy = vi.mocked(schedule.quipVisibleAt);

beforeEach(() => {
  visibleSpy.mockClear();
});

describe("bubbleCandidates skips unselected waiting records", () => {
  it("does no scheduling work for waiting records of agents that are not selected", () => {
    const old = T0 - 90 * 24 * 3_600_000;
    const records = [waiting("a1", old), waiting("a2", old), waiting("a3", T0 - 100)];
    expect(bubbleCandidates(records, {}, T0, "someone-else")).toEqual([]);
    expect(bubbleCandidates(records, {}, T0, null)).toEqual([]);
    expect(bubbleCandidates(records, {}, T0, undefined)).toEqual([]);
    expect(bubbleCandidates(records, {}, T0)).toEqual([]);
    expect(visibleSpy).not.toHaveBeenCalled();
  });

  it("still schedules the selected agent's waiting record", () => {
    const records = [waiting("a1", T0 - 100), waiting("a2", T0 - 100)];
    const result = bubbleCandidates(records, {}, T0, "a2");
    expect(result.map((c) => c.agentId)).toEqual(["a2"]);
    expect(result[0]).toMatchObject({ level: "waiting" });
    expect(visibleSpy).toHaveBeenCalledTimes(1);
  });

  it("still schedules needs-you records whether or not anything is selected", () => {
    const records = [needsYou("a1", T0 - 100), waiting("a2", T0 - 100)];
    const result = bubbleCandidates(records, {}, T0, null);
    expect(result.map((c) => c.agentId)).toEqual(["a1"]);
    expect(visibleSpy).toHaveBeenCalledTimes(1);
  });

  it("lets a skipped waiting record not hide the same agent's later record", () => {
    // The agent has an unselected waiting record first and a trouble record after it.
    const trouble: Rec = {
      agentId: "a1",
      level: "trouble",
      kind: "tool_failures",
      since: iso(T0 - 100),
      heuristic: false,
    };
    const result = bubbleCandidates([waiting("a1", T0 - 100), trouble], {}, T0, null);
    expect(result.map((c) => c.level)).toEqual(["trouble"]);
  });
});
