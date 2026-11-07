import type { Agent, Attention } from "../../data/domain.ts";
import type { DataStore } from "../../data/store.ts";
import type { CityLayout } from "../layout/index.ts";
import type { BreakDestination } from "../movement/navigator.ts";
import type { BreakPlan, BreakPlanInput } from "./types.ts";

// RED STUB (M9.08): signatures only, so the tests compile. The implementer replaces every body.

/** What the pure builder reads: the data store's slices plus the clock, setting and layout. */
export interface PlanSource {
  /** Milliseconds: the store clock (live clock, or the replay clock in history). */
  now: number;
  /** The Break time setting. */
  enabled: boolean;
  night: boolean | ((ms: number) => boolean);
  layout: CityLayout;
  /** The store's agents, in store order; finished agents are skipped. */
  agents: readonly Agent[];
  /** The store's `state.activity`: the activity label per agent id. */
  activity: Readonly<Record<string, { activity: string } | undefined>>;
  /** The store's attention records, most urgent first. */
  attention: readonly Attention[];
  /** The store's `state.sessions`; an agent has a live session when one of its sessions has no `endedAt`. */
  sessions: Readonly<Record<string, { agentId: string; endedAt?: string } | undefined>>;
}

export function planInputs(source: PlanSource): BreakPlanInput {
  return {
    now: source.now,
    enabled: source.enabled,
    night: source.night,
    sites: [],
    plazaSpots: 0,
    agents: [],
  };
}

/** Plan to navigator break spots, by agent id. */
export function breakSpots(_plan: BreakPlan, _layout: CityLayout): Map<string, BreakDestination> {
  return new Map();
}

export interface UseBreakPlanOptions {
  store?: DataStore;
  layout?: CityLayout;
}

/** The shared hook: the plan for the store's clock, re-evaluated on a coarse tick. */
export function useBreakPlan(_options: UseBreakPlanOptions = {}): BreakPlan {
  return { agents: new Map(), conversations: [] };
}
