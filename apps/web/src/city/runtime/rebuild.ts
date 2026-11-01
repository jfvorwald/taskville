import type { Navigator } from "../movement/navigator.ts";

/** A tab hidden for at least this long comes back to a rebuilt presentation. */
export const REBUILD_AFTER_MS = 2_000;

/**
 * ARCHITECTURE.md section 2.8: after a long absence the presentation is rebuilt, not replayed.
 * Reduced motion makes the next tick snap every walker to the end of its path; the user's own
 * preference is put back straight after.
 */
export function rebuildPresentation(
  nav: Navigator,
  nowMs: number,
  reduced: boolean,
  hiddenForMs: number,
): void {
  if (hiddenForMs < REBUILD_AFTER_MS) return;
  nav.setReducedMotion(true);
  try {
    nav.tick(nowMs);
  } finally {
    nav.setReducedMotion(reduced);
  }
}
