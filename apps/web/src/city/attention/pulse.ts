import type { AttentionLevelView } from "../agents/types.ts";

// The stuck-agent pulse as a pure function of the level and the time since the record began
// (ARCHITECTURE.md 2.2, blink safety). It is a smooth sine, never above 1 Hz, so it cannot
// reach 3 flashes per second. After 10 minutes unhandled it slows down but the ring stays. The
// phase is accumulated across the slowdown, so intensity never steps. Reduced motion turns the
// pulse into a steady ring.

export type PulseHue = "red" | "amber";

export interface PulseState {
  /** 0..1; how strongly the ring and rim glow are drawn. */
  intensity: number;
  /** Whether the agent gets a ring and rim glow at all. */
  ring: boolean;
  hue: PulseHue | null;
  /** Current pulse rate in Hz; 0 when steady or when there is no pulse. */
  frequencyHz: number;
}

export interface PulseInput {
  /** Milliseconds since the attention record's `since`, from the attention selector's clock. */
  elapsedMs: number;
  reducedMotion: boolean;
}

const SLOW_AFTER_MS = 10 * 60_000;
const NEEDS_YOU_HZ = 1;
const NEEDS_YOU_SLOW_HZ = 0.5;
const TROUBLE_HZ = 0.4;
/** Intensity of the steady ring under reduced motion. */
const STEADY_INTENSITY = 0.8;

/**
 * Pulse state for one agent. Pass `out` from a frame loop to reuse one object per agent; without
 * it a new object is returned.
 */
export function attentionPulse(
  level: AttentionLevelView,
  input: PulseInput,
  out: PulseState = { intensity: 0, ring: false, hue: null, frequencyHz: 0 },
): PulseState {
  if (level === "waiting") return set(out, 0, false, null, 0);
  const hue: PulseHue = level === "needs_you" ? "red" : "amber";
  if (input.reducedMotion) return set(out, STEADY_INTENSITY, true, hue, 0);

  const ms = Number.isFinite(input.elapsedMs) ? Math.max(0, input.elapsedMs) : 0;
  let cycles: number;
  let hz: number;
  if (level === "trouble") {
    hz = TROUBLE_HZ;
    cycles = (ms / 1000) * hz;
  } else if (ms <= SLOW_AFTER_MS) {
    hz = NEEDS_YOU_HZ;
    cycles = (ms / 1000) * hz;
  } else {
    hz = NEEDS_YOU_SLOW_HZ;
    cycles = (SLOW_AFTER_MS / 1000) * NEEDS_YOU_HZ + ((ms - SLOW_AFTER_MS) / 1000) * hz;
  }
  const intensity = 0.5 - 0.5 * Math.cos(2 * Math.PI * cycles);
  return set(out, Math.min(1, Math.max(0, intensity)), true, hue, hz);
}

function set(
  out: PulseState,
  intensity: number,
  ring: boolean,
  hue: PulseHue | null,
  frequencyHz: number,
): PulseState {
  out.intensity = intensity;
  out.ring = ring;
  out.hue = hue;
  out.frequencyHz = frequencyHz;
  return out;
}
