import { describe, expect, it } from "vitest";
import {
  CLAIM_WALK_MS,
  claimWalkFrame,
  initialClaimWalk,
  observeClaim,
  stillClaimFrame,
} from "../../../../src/city/crew/teams/claim.ts";

// When a teammate claims a task it walks from Dispatch to the matching work area (ARCHITECTURE
// 2.9). The walk is a pure function of the claim events observed and a caller-supplied clock: it
// never starts, advances or finishes without a recorded claim (constitution IV).

const T0 = 50_000;

const claimed = (taskId = "task-1", atMs = T0) =>
  observeClaim(initialClaimWalk(), { taskId, atMs });

describe("claim walk", () => {
  it("stays at Dispatch with no progress before any claim is observed, whatever the clock says", () => {
    for (const now of [0, T0, T0 + CLAIM_WALK_MS * 100]) {
      expect(claimWalkFrame(initialClaimWalk(), now)).toMatchObject({
        phase: "at_dispatch",
        progress: 0,
        outward: 0,
      });
    }
  });

  it("starts walking at the moment of the claim", () => {
    expect(claimWalkFrame(claimed(), T0)).toMatchObject({
      phase: "walking",
      progress: 0,
      outward: 0,
    });
  });

  it("reports progress through the walk, then arrives at the work area", () => {
    const s = claimed();
    const half = claimWalkFrame(s, T0 + CLAIM_WALK_MS / 2);
    expect(half.phase).toBe("walking");
    expect(half.progress).toBeCloseTo(0.5);
    expect(half.outward).toBeCloseTo(0.5);
    expect(claimWalkFrame(s, T0 + CLAIM_WALK_MS - 1).phase).toBe("walking");
    expect(claimWalkFrame(s, T0 + CLAIM_WALK_MS)).toMatchObject({
      phase: "arrived",
      progress: 1,
      outward: 1,
    });
  });

  it("does not start early when the clock reads before the claim", () => {
    expect(claimWalkFrame(claimed(), T0 - 500)).toMatchObject({ progress: 0, outward: 0 });
  });

  it("ignores a repeat of the same claim, so a replay never restarts the walk", () => {
    const once = claimed("task-1", T0);
    const twice = observeClaim(once, { taskId: "task-1", atMs: T0 + 10_000 });
    expect(twice).toEqual(once);
    expect(claimWalkFrame(twice, T0 + CLAIM_WALK_MS).phase).toBe("arrived");
  });

  it("walks again from Dispatch when a different task is claimed", () => {
    const next = observeClaim(claimed("task-1", T0), { taskId: "task-2", atMs: T0 + 20_000 });
    expect(claimWalkFrame(next, T0 + 20_000)).toMatchObject({ phase: "walking", outward: 0 });
    expect(claimWalkFrame(next, T0 + 20_000 + CLAIM_WALK_MS).phase).toBe("arrived");
  });

  it("does not change the state it is given", () => {
    const s = initialClaimWalk();
    const before = JSON.stringify(s);
    observeClaim(s, { taskId: "task-1", atMs: T0 });
    expect(JSON.stringify(s)).toBe(before);
  });

  describe("reduced motion", () => {
    it("jumps to the work area for a walk in progress and for an arrived teammate", () => {
      const s = claimed();
      expect(stillClaimFrame(claimWalkFrame(s, T0 + CLAIM_WALK_MS / 2)).outward).toBe(1);
      expect(stillClaimFrame(claimWalkFrame(s, T0 + CLAIM_WALK_MS)).outward).toBe(1);
    });

    it("keeps a teammate that has not claimed anything at Dispatch", () => {
      expect(stillClaimFrame(claimWalkFrame(initialClaimWalk(), T0)).outward).toBe(0);
    });
  });
});
