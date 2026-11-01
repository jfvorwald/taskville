// One subagent's visit, as a pure function of when its start and finish were observed
// (ARCHITECTURE 2.9): it walks out of the parent's door, works for as long as it takes, then
// comes back with a result cube, hands it over and fades at the door. Nothing here reads a
// clock: the caller passes `nowMs`, so tests and the tab-return rebuild use the same code.

export const WALK_OUT_MS = 2500;
export const RETURN_MS = 2500;
export const HAND_OVER_MS = 800;
export const FADE_MS = 700;

export type SubagentPhase =
  | "absent"
  | "walking_out"
  | "working"
  | "returning"
  | "handing_over"
  | "fading"
  | "gone";

export interface LifecycleState {
  readonly startedAtMs?: number;
  readonly finishedAtMs?: number;
}

export interface LifecycleEvent {
  readonly kind: "started" | "finished";
  readonly atMs: number;
}

export interface SubagentFrame {
  readonly phase: SubagentPhase;
  /** How far through the current phase, 0 to 1. */
  readonly progress: number;
  /** How far from the door toward the work spot: 0 at the door, 1 at the spot. */
  readonly outward: number;
  readonly carrying: boolean;
  readonly opacity: number;
}

export function initialLifecycle(): LifecycleState {
  return {};
}

/** The state after `event`. A repeated start or finish is ignored, so a replay never restarts. */
export function observeSubagent(state: LifecycleState, event: LifecycleEvent): LifecycleState {
  if (event.kind === "started") {
    return state.startedAtMs === undefined ? { ...state, startedAtMs: event.atMs } : state;
  }
  return state.finishedAtMs === undefined ? { ...state, finishedAtMs: event.atMs } : state;
}

const clamp01 = (n: number): number => Math.min(1, Math.max(0, n));

function frame(
  phase: SubagentPhase,
  progress: number,
  outward: number,
  carrying: boolean,
  opacity: number,
): SubagentFrame {
  return { phase, progress, outward, carrying, opacity };
}

export function subagentFrame(state: LifecycleState, nowMs: number): SubagentFrame {
  const { startedAtMs, finishedAtMs } = state;
  if (finishedAtMs !== undefined) {
    // How far out it had got when the finish arrived; a finish mid-walk heads home from there.
    const reached =
      startedAtMs === undefined ? 1 : clamp01((finishedAtMs - startedAtMs) / WALK_OUT_MS);
    const since = Math.max(0, nowMs - finishedAtMs);
    if (since < RETURN_MS) {
      const progress = since / RETURN_MS;
      return frame("returning", progress, reached * (1 - progress), true, 1);
    }
    const handed = since - RETURN_MS;
    if (handed < HAND_OVER_MS) return frame("handing_over", handed / HAND_OVER_MS, 0, true, 1);
    const faded = handed - HAND_OVER_MS;
    if (faded < FADE_MS) {
      const progress = faded / FADE_MS;
      return frame("fading", progress, 0, false, 1 - progress);
    }
    return frame("gone", 1, 0, false, 0);
  }
  if (startedAtMs === undefined) return frame("absent", 0, 0, false, 0);
  const walked = Math.max(0, nowMs - startedAtMs);
  if (walked < WALK_OUT_MS) {
    const progress = walked / WALK_OUT_MS;
    return frame("walking_out", progress, progress, false, 1);
  }
  return frame("working", 1, 1, false, 1);
}

/**
 * The same visit without the in-between motion (reduced motion): the bot is at its spot while
 * leaving or working, at the door otherwise, and disappears at the end of the fade, never fading.
 */
export function stillFrame(f: SubagentFrame): SubagentFrame {
  const out = f.phase === "walking_out" || f.phase === "working";
  return { ...f, outward: out ? 1 : 0, opacity: f.phase === "fading" ? 1 : f.opacity };
}

/** A parent waits while any of its subagents is on the way out or at work. */
export function parentIsWaiting(phases: readonly SubagentPhase[]): boolean {
  return phases.some((p) => p === "walking_out" || p === "working");
}
