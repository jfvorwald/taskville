/** Replay speeds up to this multiplier still play celebrations (ARCHITECTURE.md 2.6). */
export const MAX_CELEBRATION_SPEED = 10;

/** Whether celebrations play at a replay speed: 1x and 10x do, anything faster is suppressed. */
export function celebrationsAtSpeed(multiplier: number): "play" | "suppress" {
  return multiplier <= MAX_CELEBRATION_SPEED ? "play" : "suppress";
}
