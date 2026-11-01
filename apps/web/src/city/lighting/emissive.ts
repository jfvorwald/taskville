/**
 * The shared emissive level for window and lamp glow: one number in 0..1 that every glow material
 * is scaled by (ARCHITECTURE.md section 2.5, "one shared uniform for the emissives"). Pure: the
 * lighting controller's `nightness` in, a level out. A dim glow remains by day, so lit windows
 * read as lit, and it ramps to full as night falls.
 */

/** The glow level in full day: at most a quarter of the night level. */
export const DAY_EMISSIVE = 0.15;

export function emissiveLevel(nightness: number): number {
  const n = Math.min(1, Math.max(0, nightness));
  return n >= 1 ? 1 : DAY_EMISSIVE + (1 - DAY_EMISSIVE) * n;
}
