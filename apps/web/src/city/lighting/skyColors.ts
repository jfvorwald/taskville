import { mixHex } from "../../themes/core/color.ts";
import type { ThemeTokens } from "../../themes/core/contract.ts";
import type { LightingState } from "./phase.ts";

/** Everything the lights need as plain numbers and hex strings (no three.js here, so it tests). */
export interface LightRig {
  /** Scene background: the theme's day sky blended to its night sky. */
  sky: string;
  hemisphereSky: string;
  hemisphereGround: string;
  sunColor: string;
  sunPosition: [number, number, number];
  ambientIntensity: number;
  sunIntensity: number;
}

const DAY_LIGHT = "#fff3de";
const WARM_LIGHT = "#ffb06b";
const MOON_LIGHT = "#9db4ff";
const DAY_GROUND = "#8d93a0";
const SUN_DISTANCE = 14;
const SUN_BASE_HEIGHT = 8;
const SUN_PEAK_HEIGHT = 16;
const SUN_Z = 16;

/**
 * Sun and moon share one arc: x follows the cosine of the sun angle and height its sine, mirrored
 * below the horizon, so the light is continuous through sunset and sunrise (the moon rises where
 * the sun set). At noon it sits at x 0, y 24 (the old fixed light was at x -12, y 24).
 */
export function sunPosition(sunAngleDeg: number): [number, number, number] {
  const a = (sunAngleDeg * Math.PI) / 180;
  return [
    -SUN_DISTANCE * Math.cos(a),
    SUN_BASE_HEIGHT + SUN_PEAK_HEIGHT * Math.abs(Math.sin(a)),
    SUN_Z,
  ];
}

/**
 * Blend the theme's day and night token sets by `nightness`. The night set is the theme's own
 * night palette (M3.07), so each theme keeps its night sky: cyberpunk a near-black navy, and so on.
 */
export function lightRig(state: LightingState, day: ThemeTokens, night: ThemeTokens): LightRig {
  const n = state.nightness;
  const sky = mixHex(day["--tv-scene-bg"], night["--tv-scene-bg"], n);
  const nightSky = mixHex(night["--tv-scene-bg"], "#ffffff", 0.35);
  const nightGround = mixHex(night["--tv-scene-bg"], "#000000", 0.3);
  // Day light warms toward the middle of dusk or dawn (nightness 0.5), then cools to moonlight.
  const sunColor =
    n < 0.5 ? mixHex(DAY_LIGHT, WARM_LIGHT, n * 2) : mixHex(WARM_LIGHT, MOON_LIGHT, (n - 0.5) * 2);
  return {
    sky,
    hemisphereSky: mixHex("#ffffff", nightSky, n),
    hemisphereGround: mixHex(DAY_GROUND, nightGround, n),
    sunColor,
    sunPosition: sunPosition(state.sunAngleDeg),
    ambientIntensity: state.ambientIntensity,
    sunIntensity: state.sunIntensity,
  };
}
