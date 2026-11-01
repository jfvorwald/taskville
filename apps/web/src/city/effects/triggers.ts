import type { StoredEnvelope } from "../../data/domain.ts";
import { celebrationsAtSpeed } from "./speed.ts";

// Which recorded events celebrate, and how (ARCHITECTURE.md 2.6). Pure: no React, no three.js, no
// clock of its own. The renderer feeds it events and plays what comes back.

/** One burst per city per this many milliseconds; later ones are dropped, never queued. */
export const MIN_BURST_INTERVAL_MS = 2000;
/** The pooled particle budget for one confetti pop. */
export const CONFETTI_MAX_PARTICLES = 40;
export const CONFETTI_DURATION_MS = 1200;

export type SparkleSource = "confetti" | "high-five" | "merge-burst" | "shimmer";

export type Celebration =
  | {
      readonly kind: "confetti";
      readonly agentId: string;
      readonly particles: number;
      readonly durationMs: number;
    }
  | { readonly kind: "high-five"; readonly fromAgentId: string; readonly toAgentId: string }
  | { readonly kind: "merge-burst"; readonly area: "archives" }
  | { readonly kind: "shimmer"; readonly area: "test-lab" }
  /** Reduced motion: the one icon every celebration becomes. */
  | { readonly kind: "sparkle"; readonly source: SparkleSource; readonly agentId?: string };

export interface CelebrationsOptions {
  /** Milliseconds; the rate limit runs on this clock, not on event times. */
  now: () => number;
  reducedMotion?: boolean;
}

export interface Celebrations {
  /** The celebrations to play for `event`: none, or exactly one. */
  handle(event: StoredEnvelope): Celebration[];
  setReducedMotion(on: boolean): void;
  /** The replay speed multiplier (1 when live). Celebrations are suppressed above 10x. */
  setSpeed(multiplier: number): void;
}

function sparkle(c: Celebration): Celebration {
  switch (c.kind) {
    case "sparkle":
      return c;
    case "confetti":
      return { kind: "sparkle", source: "confetti", agentId: c.agentId };
    default:
      return { kind: "sparkle", source: c.kind };
  }
}

export function createCelebrations(options: CelebrationsOptions): Celebrations {
  let reducedMotion = options.reducedMotion ?? false;
  let speed = 1;
  let lastBurstAt: number | null = null;
  // Agents whose latest recorded test.result was red. A guessed test run never lands here.
  const red = new Set<string>();

  /** The celebration an event asks for, before speed, rate limit and reduced motion. */
  function wanted(event: StoredEnvelope): Celebration | null {
    switch (event.type) {
      case "task.status_changed":
        if (event.payload.status !== "completed" || event.agentId === undefined) return null;
        return {
          kind: "confetti",
          agentId: event.agentId,
          particles: CONFETTI_MAX_PARTICLES,
          durationMs: CONFETTI_DURATION_MS,
        };
      case "task.handoff":
        return {
          kind: "high-five",
          fromAgentId: event.payload.fromAgentId,
          toAgentId: event.payload.toAgentId,
        };
      case "git.merge":
        return { kind: "merge-burst", area: "archives" };
      case "test.result": {
        const agent = event.agentId ?? "";
        const { passed, failed } = event.payload;
        if (failed > 0) {
          red.add(agent);
          return null;
        }
        // Green after red, once per red. Tracked even while suppressed, so it is not replayed.
        if (passed > 0 && red.delete(agent)) return { kind: "shimmer", area: "test-lab" };
        return null;
      }
      default:
        return null;
    }
  }

  return {
    handle(event) {
      const celebration = wanted(event);
      if (celebration === null || celebrationsAtSpeed(speed) === "suppress") return [];
      const now = options.now();
      if (lastBurstAt !== null && now - lastBurstAt < MIN_BURST_INTERVAL_MS) return [];
      lastBurstAt = now;
      return [reducedMotion ? sparkle(celebration) : celebration];
    },
    setReducedMotion(on) {
      reducedMotion = on;
    },
    setSpeed(multiplier) {
      speed = multiplier;
    },
  };
}
