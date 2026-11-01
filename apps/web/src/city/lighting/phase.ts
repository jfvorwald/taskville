import type { ThemeMode } from "../../themes/core/contract.ts";

/**
 * Pure day and night math. No clock, no three.js, no DOM: a minute of the local day in, a
 * lighting state out. The controller supplies the minute (from the browser clock or an injected
 * time) and the components apply the state.
 *
 * The day is fixed, not solar: dawn 05:30-07:30, day to 17:30, dusk 17:30-19:30, night after.
 * ARCHITECTURE.md section 2.5 wants the viewer's local clock, not a location, so there is no
 * latitude or season. The sun crosses the horizon at 06:30 and 18:30.
 */

export type LightingPhase = "night" | "dawn" | "day" | "dusk";

const HOUR = 60;
export const PHASE_BOUNDS = {
  dawnStart: 5.5 * HOUR,
  dayStart: 7.5 * HOUR,
  duskStart: 17.5 * HOUR,
  nightStart: 19.5 * HOUR,
} as const;

const SUNRISE = 6.5 * HOUR;
const SUN_PEAK_DEG = 75;
const DAY_MINUTES = 24 * HOUR;

/** Minutes after local midnight for an instant (ms since epoch) in an IANA zone. */
export function localMinutes(instantMs: number, timeZone: string): number {
  const parts = (zone: string) =>
    new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      hour: "numeric",
      minute: "numeric",
    }).formatToParts(new Date(instantMs));
  let found: Intl.DateTimeFormatPart[];
  try {
    found = parts(timeZone);
  } catch {
    found = parts("UTC");
  }
  const get = (type: string) => Number(found.find((p) => p.type === type)?.value ?? 0);
  return (get("hour") % 24) * HOUR + get("minute");
}

/** The browser's zone, or UTC when the runtime cannot say. */
export function browserTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return "UTC";
  }
}

export function phaseAt(minutes: number): LightingPhase {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  if (m >= PHASE_BOUNDS.nightStart || m < PHASE_BOUNDS.dawnStart) return "night";
  if (m < PHASE_BOUNDS.dayStart) return "dawn";
  if (m < PHASE_BOUNDS.duskStart) return "day";
  return "dusk";
}

export interface LightingState {
  phase: LightingPhase;
  /** 0 in full day, 1 in full night, smooth through dawn and dusk. */
  nightness: number;
  /**
   * The theme palette to use: night once `nightness` reaches one half. Window emissives and
   * street lamps are part of the palette, so they switch on here: the middle of dusk.
   */
  mode: ThemeMode;
  /** Sun height above the horizon in degrees; negative at night. */
  sunElevationDeg: number;
  /** 0 at sunrise (east) to 180 at sunset (west), continuing around through the night. */
  sunAngleDeg: number;
  /** Hemisphere (ambient) light intensity. */
  ambientIntensity: number;
  /** Directional light intensity (the sun by day, a dim moon at night). */
  sunIntensity: number;
}

const smooth = (t: number) => t * t * (3 - 2 * t);
const lerp = (a: number, b: number, t: number) => a + (b - a) * t;

export const DAY_AMBIENT = 1.15;
export const NIGHT_AMBIENT = 1.1;
export const DAY_SUN = 1.4;
export const NIGHT_SUN = 0.9;

export function nightnessAt(minutes: number): number {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  switch (phaseAt(m)) {
    case "night":
      return 1;
    case "day":
      return 0;
    case "dawn":
      return (
        1 - smooth((m - PHASE_BOUNDS.dawnStart) / (PHASE_BOUNDS.dayStart - PHASE_BOUNDS.dawnStart))
      );
    case "dusk":
      return smooth(
        (m - PHASE_BOUNDS.duskStart) / (PHASE_BOUNDS.nightStart - PHASE_BOUNDS.duskStart),
      );
  }
}

export function computeLighting(minutes: number): LightingState {
  const m = ((minutes % DAY_MINUTES) + DAY_MINUTES) % DAY_MINUTES;
  const phase = phaseAt(m);
  const nightness = nightnessAt(m);
  const turn = ((m - SUNRISE + DAY_MINUTES) % DAY_MINUTES) / DAY_MINUTES;
  const sunAngleDeg = turn * 360;
  const sunElevationDeg = SUN_PEAK_DEG * Math.sin(turn * 2 * Math.PI);
  return {
    phase,
    nightness,
    mode: nightness >= 0.5 ? "night" : "day",
    sunElevationDeg,
    sunAngleDeg,
    ambientIntensity: lerp(DAY_AMBIENT, NIGHT_AMBIENT, nightness),
    sunIntensity: lerp(DAY_SUN, NIGHT_SUN, nightness),
  };
}
