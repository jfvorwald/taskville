import { hash32, seededRandom } from "./hash.ts";

/** How long a bubble stays up. */
export const QUIP_VISIBLE_MS = 4000;

const MIN_GAP_MS = 45_000;
const MAX_GAP_MS = 90_000;

/** Quips stop for a state this old (the red ring stays), which bounds the work per call. */
export const QUIP_MAX_AGE_MS = 24 * 3_600_000;

export interface QuipWindow {
  startMs: number;
  endMs: number;
}

export interface QuipScheduleInput {
  agentId: string;
  eventId: string;
  /** When the state began, in the same milliseconds as the clock passed to `quipVisibleAt`. */
  sinceMs: number;
}

/** The seeded gap draw: the same IDs give the same run of gaps, in order. */
function gaps({ agentId, eventId }: QuipScheduleInput): () => number {
  const random = seededRandom(hash32(agentId, eventId));
  return () => MIN_GAP_MS + Math.floor(random() * (MAX_GAP_MS - MIN_GAP_MS + 1));
}

/**
 * The first `count` times a bubble shows: one at `sinceMs`, then one every 45 to 90 s. The gaps
 * are seeded from the agent and event IDs and drawn in order, so asking for more windows never
 * changes the earlier ones. No clock and no random source.
 */
export function quipSchedule(input: QuipScheduleInput & { count: number }): QuipWindow[] {
  const nextGap = gaps(input);
  const windows: QuipWindow[] = [];
  let startMs = input.sinceMs;
  for (let i = 0; i < input.count; i++) {
    windows.push({ startMs, endMs: startMs + QUIP_VISIBLE_MS });
    startMs += nextGap();
  }
  return windows;
}

/**
 * Whether a bubble for this state is up at `nowMs`. A state 24 h old or more shows none, so the
 * scan is at most 24 h of gaps (about 1,900 draws) however old `sinceMs` is.
 */
export function quipVisibleAt(input: QuipScheduleInput, nowMs: number): boolean {
  if (nowMs - input.sinceMs >= QUIP_MAX_AGE_MS) return false;
  const nextGap = gaps(input);
  let startMs = input.sinceMs;
  while (startMs <= nowMs) {
    if (nowMs < startMs + QUIP_VISIBLE_MS) return true;
    startMs += nextGap();
  }
  return false;
}
