import { describe, expect, it } from "vitest";
import { TEAMMATE_QUIET_MS, teammateIdle } from "../../../../src/city/crew/teams/idle.ts";

// A teammate that has finished its turn sits at its workstation with "zzz" (ARCHITECTURE 2.9).
// Idle is shown as observed when the source recorded it (TeammateIdle ends the activity) and
// nothing is in progress. Without that record, a long quiet with nothing in progress is only a
// guess: it still shows "zzz", but flagged heuristic (constitution IV). The clock is injected.

const NOW = 1_000_000;
const base = { activity: "idle", openToolCalls: 0, claimedTasks: 0 } as const;

describe("teammateIdle", () => {
  it("is idle, observed, when the source recorded idle and nothing is in progress", () => {
    expect(teammateIdle({ ...base, lastEventAtMs: NOW - 1000 }, NOW)).toEqual({
      idle: true,
      heuristic: false,
      emote: "zzz",
    });
  });

  it("is not idle while a tool call is open, even after a recorded idle", () => {
    const r = teammateIdle({ ...base, openToolCalls: 1, lastEventAtMs: NOW - 1000 }, NOW);
    expect(r).toMatchObject({ idle: false, emote: null });
  });

  it("is not idle while it holds a claimed task in progress", () => {
    const r = teammateIdle({ ...base, claimedTasks: 1, lastEventAtMs: NOW - 1000 }, NOW);
    expect(r).toMatchObject({ idle: false, emote: null });
  });

  it("is not idle while it records an activity", () => {
    const r = teammateIdle(
      { activity: "implementing", openToolCalls: 0, claimedTasks: 0, lastEventAtMs: NOW - 1000 },
      NOW,
    );
    expect(r).toMatchObject({ idle: false, emote: null });
  });

  it("guesses idle, flagged heuristic, after a long quiet with nothing in progress", () => {
    const r = teammateIdle(
      {
        activity: "unknown",
        openToolCalls: 0,
        claimedTasks: 0,
        lastEventAtMs: NOW - TEAMMATE_QUIET_MS,
      },
      NOW,
    );
    expect(r).toEqual({ idle: true, heuristic: true, emote: "zzz" });
  });

  it("does not guess idle before the quiet threshold", () => {
    const r = teammateIdle(
      {
        activity: "unknown",
        openToolCalls: 0,
        claimedTasks: 0,
        lastEventAtMs: NOW - TEAMMATE_QUIET_MS + 1,
      },
      NOW,
    );
    expect(r).toMatchObject({ idle: false, emote: null });
  });

  it("never guesses idle while a tool call is open or a task is claimed, however quiet", () => {
    const quiet = { activity: "unknown", lastEventAtMs: NOW - TEAMMATE_QUIET_MS * 10 } as const;
    expect(teammateIdle({ ...quiet, openToolCalls: 1, claimedTasks: 0 }, NOW).idle).toBe(false);
    expect(teammateIdle({ ...quiet, openToolCalls: 0, claimedTasks: 1 }, NOW).idle).toBe(false);
  });

  it("does not guess from silence it never observed: no last event, no recorded idle", () => {
    const r = teammateIdle({ activity: "unknown", openToolCalls: 0, claimedTasks: 0 }, NOW);
    expect(r).toMatchObject({ idle: false, emote: null });
  });

  it("reads the injected clock only: the same input and time give the same answer", () => {
    const input = {
      activity: "unknown",
      openToolCalls: 0,
      claimedTasks: 0,
      lastEventAtMs: 0,
    } as const;
    expect(teammateIdle(input, TEAMMATE_QUIET_MS)).toEqual(teammateIdle(input, TEAMMATE_QUIET_MS));
    expect(teammateIdle(input, TEAMMATE_QUIET_MS - 1).idle).toBe(false);
    expect(teammateIdle(input, TEAMMATE_QUIET_MS).idle).toBe(true);
  });
});
