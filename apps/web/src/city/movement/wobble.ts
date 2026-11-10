// The tipsy sway on the walk back from the bar (break time design). A sideways offset in meters,
// a pure function of how far along the walk the agent is, so it needs no state and never jumps:
// the sway fades in from the bar and out at the workstation.

const AMPLITUDE_M = 0.2;
const SWAYS = 3;

/** Sideways offset (m) at `progress` 0 (the bar) to 1 (the workstation); 0 under reduced motion. */
export function wobbleOffset(progress: number, reducedMotion: boolean): number {
  if (reducedMotion) return 0;
  const p = Math.min(1, Math.max(0, progress));
  return AMPLITUDE_M * Math.sin(Math.PI * p) * Math.sin(2 * Math.PI * SWAYS * p);
}
