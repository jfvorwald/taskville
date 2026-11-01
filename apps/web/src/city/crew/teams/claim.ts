// Presentation interpolation only. The mounted city uses the shared street navigator.
export const CLAIM_WALK_MS = 2000;
interface Claim {
  readonly taskId: string;
  readonly atMs: number;
}
interface ClaimWalk {
  readonly claim?: Claim;
}
interface ClaimFrame {
  readonly phase: "at_dispatch" | "walking" | "arrived";
  readonly progress: number;
  readonly outward: number;
}
export function initialClaimWalk(): ClaimWalk {
  return {};
}
export function observeClaim(state: ClaimWalk, claim: Claim): ClaimWalk {
  return state.claim?.taskId === claim.taskId ? state : { claim };
}
export function claimWalkFrame(state: ClaimWalk, nowMs: number): ClaimFrame {
  if (state.claim === undefined) return { phase: "at_dispatch", progress: 0, outward: 0 };
  const progress = Math.max(0, Math.min(1, (nowMs - state.claim.atMs) / CLAIM_WALK_MS));
  return { phase: progress === 1 ? "arrived" : "walking", progress, outward: progress };
}
export function stillClaimFrame(frame: ClaimFrame): ClaimFrame {
  return frame.phase === "at_dispatch" ? frame : { phase: "arrived", progress: 1, outward: 1 };
}
