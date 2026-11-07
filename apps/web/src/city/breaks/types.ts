/**
 * Types for the break planner (break time design, M9.01). Presentation only: nothing here is
 * ever written back to the domain (constitution IV, ARCHITECTURE.md section 11).
 */

/** Rest states the planner reads (mirrors `RestState` in `city/movement/models.ts`). */
export type BreakRest = "working" | "waiting" | "idle";

/** Domain attention levels (`packages/domain/src/selectors/attention.ts`); null = no record. */
export type BreakLevel = "needs_you" | "trouble" | "waiting" | null;

export type BreakSiteKind = "bar" | "smoke";

export type BreakActivity = "bar" | "smoke" | "stroll" | "juggle" | "stargaze" | "pigeons";

/** A break site handed in by the caller (M9.02 builds these from the layout). */
export interface BreakSite {
  id: string;
  kind: BreakSiteKind;
  /** How many agents it holds. */
  spots: number;
}

export interface BreakAgentInput {
  id: string;
  rest: BreakRest;
  level: BreakLevel;
  /** Event ID of the waiting record (the quips seed input), or null. */
  waitingEventId: string | null;
  /** When the waiting record began, in the same milliseconds as `now`, or null. */
  waitingSince: number | null;
  liveSession: boolean;
}

export interface BreakPlanInput {
  /** The injected clock, in milliseconds (live clock or replay clock). */
  now: number;
  /** The "Break time" setting. Off gives an empty plan. */
  enabled: boolean;
  /**
   * Stargazing is only offered at night, judged at each segment's start time. A boolean means
   * night for all times; a function says whether a given time (ms) is night.
   */
  night: boolean | ((ms: number) => boolean);
  sites: readonly BreakSite[];
  /** Spots in the plaza for strolls, juggling, stargazing and pigeons. */
  plazaSpots: number;
  agents: readonly BreakAgentInput[];
}

export interface AgentBreak {
  activity: BreakActivity;
  /** The site the agent is at; null means the plaza. */
  siteId: string | null;
  /** Spot index within the site (or plaza): 0 <= spot < spots. */
  spot: number;
  /** Bounds of the current activity: startedAt <= now < endsAt. */
  startedAt: number;
  endsAt: number;
}

export interface Conversation {
  /** Lower sorted ID. */
  a: string;
  /** Higher sorted ID. */
  b: string;
  /** Where they stand; null means the plaza. */
  siteId: string | null;
  /** Which bubble is up: 0, 1, 2 ... (even turns the headline, odd the reaction). */
  turn: number;
  /** When the current turn began; turnStartedAt <= now < turnStartedAt + BUBBLE_TURN_MS. */
  turnStartedAt: number;
}

export interface BreakPlan {
  /** Only agents on break appear. Keyed by agent ID. */
  agents: Map<string, AgentBreak>;
  conversations: Conversation[];
}

/** A bubble turn lasts 6 s. */
export const BUBBLE_TURN_MS = 6000;
/** The seeded delay after waiting began before a break starts: 60 to 120 s. */
export const MIN_BREAK_DELAY_MS = 60_000;
export const MAX_BREAK_DELAY_MS = 120_000;
/** A seeded activity lasts 2 to 5 minutes. */
export const MIN_ACTIVITY_MS = 120_000;
export const MAX_ACTIVITY_MS = 300_000;
