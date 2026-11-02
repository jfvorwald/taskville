// Crowding (ARCHITECTURE 2.9): up to three subagents per parent get their own bot; the rest stand
// behind one "+N crew" marker. Clicking the marker fans them all out for a short while.

export const CREW_INDIVIDUAL_LIMIT = 3;
/** How long a click on the marker keeps every bot out. */
export const FAN_OUT_MS = 4000;

export interface CrewClock {
  readonly nowMs: number;
  /** When the marker was last clicked, on the same clock as `nowMs`. */
  readonly fannedAtMs?: number;
}

export interface CrewMarker {
  readonly count: number;
  readonly hiddenIds: string[];
}

export interface CrewView {
  /** Ids that get their own bot, in input order. */
  readonly individual: string[];
  readonly marker?: CrewMarker;
}

export function collapseCrew(ids: readonly string[], clock: CrewClock): CrewView {
  const { nowMs, fannedAtMs } = clock;
  const fanned = fannedAtMs !== undefined && nowMs >= fannedAtMs && nowMs < fannedAtMs + FAN_OUT_MS;
  if (fanned || ids.length <= CREW_INDIVIDUAL_LIMIT) return { individual: [...ids] };
  const hiddenIds = ids.slice(CREW_INDIVIDUAL_LIMIT);
  return {
    individual: ids.slice(0, CREW_INDIVIDUAL_LIMIT),
    marker: { count: hiddenIds.length, hiddenIds },
  };
}

export function crewMarkerLabel(count: number): string {
  return `+${count} crew`;
}
