import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import type { Agent, Attention } from "../../data/domain.ts";
import { useData } from "../../data/react.ts";
import { type DataStore, dataStore } from "../../data/store.ts";
import { getSettingsStore } from "../../overlays/settings/store.ts";
import { applyStrictAttribution } from "../crew/strict-attribution/index.ts";
import { CITY_LAYOUT, type CityLayout } from "../layout/index.ts";
import { lightingController } from "../lighting/instance.ts";
import { computeLighting, localMinutes } from "../lighting/phase.ts";
import { useLighting } from "../lighting/react.ts";
import type { BreakDestination } from "../movement/navigator.ts";
import { planBreaks } from "./plan.ts";
import type { BreakAgentInput, BreakPlan, BreakPlanInput, BreakRest } from "./types.ts";

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

/** The same rest the navigator reads (`models.ts`): a waiting record or activity, idle, else working. */
function restOf(level: Attention["level"] | null, activity: string | undefined): BreakRest {
  if (level === "waiting" || activity === "waiting") return "waiting";
  return activity === "idle" ? "idle" : "working";
}

/**
 * The attention view the city draws: strict attribution drops heuristic needs-you records, so the
 * planner sees the agent as waiting exactly when the city does. Strict off returns the input.
 */
export function plannerAttention(
  attention: readonly Attention[],
  strict: boolean,
): readonly Attention[] {
  return applyStrictAttribution({ agents: {}, teams: undefined, attention }, strict).attention;
}

export function planInputs(source: PlanSource): BreakPlanInput {
  const { layout } = source;
  const firstRecord = new Map<string, Attention>();
  for (const record of source.attention) {
    if (!firstRecord.has(record.agentId)) firstRecord.set(record.agentId, record);
  }
  const live = new Set<string>();
  for (const session of Object.values(source.sessions)) {
    if (session !== undefined && session.endedAt === undefined) live.add(session.agentId);
  }
  const agents: BreakAgentInput[] = [];
  for (const agent of source.agents) {
    if (agent.finishedAt !== undefined) continue;
    const record = firstRecord.get(agent.id);
    const level = record?.level ?? null;
    const since = record?.level === "waiting" ? Date.parse(record.since) : Number.NaN;
    agents.push({
      id: agent.id,
      rest: restOf(level, source.activity[agent.id]?.activity),
      level,
      waitingEventId:
        record?.level === "waiting" ? (record.requestId ?? `${record.kind}@${record.since}`) : null,
      waitingSince: Number.isNaN(since) ? null : since,
      liveSession: live.has(agent.id),
    });
  }
  return {
    now: source.now,
    enabled: source.enabled,
    night: source.night,
    sites: layout.breakSites.map((s) => ({ id: s.id, kind: s.id, spots: s.spots.length })),
    plazaSpots: layout.graph.nodes.filter((n) => n.kind === "plaza").length,
    agents,
  };
}

/** Plan to navigator break spots, by agent id. */
export function breakSpots(plan: BreakPlan, layout: CityLayout): Map<string, BreakDestination> {
  const spots = new Map<string, BreakDestination>();
  for (const [id, b] of plan.agents) {
    if (b.siteId === null) {
      spots.set(id, { kind: "plaza", index: b.spot });
      continue;
    }
    const nodeId = layout.breakSites.find((s) => s.id === b.siteId)?.spots[b.spot]?.nodeId;
    if (nodeId !== undefined) spots.set(id, { kind: "site", nodeId });
  }
  return spots;
}

export interface UseBreakPlanOptions {
  store?: DataStore;
  layout?: CityLayout;
}

/** How often the plan is re-read against the clock; the plan itself is never computed per frame. */
const TICK_MS = 1000;

function samePlan(a: BreakPlan, b: BreakPlan): boolean {
  if (a.agents.size !== b.agents.size || a.conversations.length !== b.conversations.length) {
    return false;
  }
  for (const [id, x] of a.agents) {
    const y = b.agents.get(id);
    if (
      y === undefined ||
      x.activity !== y.activity ||
      x.siteId !== y.siteId ||
      x.spot !== y.spot ||
      x.startedAt !== y.startedAt ||
      x.endsAt !== y.endsAt
    ) {
      return false;
    }
  }
  return a.conversations.every((x, i) => {
    const y = b.conversations[i] as BreakPlan["conversations"][number];
    return (
      x.a === y.a &&
      x.b === y.b &&
      x.siteId === y.siteId &&
      x.turn === y.turn &&
      x.turnStartedAt === y.turnStartedAt
    );
  });
}

/** Night at a moment, from the lighting setting (the cycle follows the clock in its time zone). */
function nightAt(ms: number): boolean {
  const setting = lightingController.getSetting();
  if (setting === "always-day") return false;
  if (setting === "always-night") return true;
  return computeLighting(localMinutes(ms, lightingController.timeZone)).mode === "night";
}

/**
 * The shared hook: the plan for the store's clock, re-evaluated on a coarse tick and on store,
 * setting and lighting changes. The first render's plan is already right. The returned plan keeps
 * its identity while nothing in it changed, so consumers re-run only on a real change.
 */
export function useBreakPlan({
  store = dataStore,
  layout = CITY_LAYOUT,
}: UseBreakPlanOptions = {}): BreakPlan {
  const agents = useData((s) => s.agents, store);
  const attention = useData((s) => s.attention, store);
  const state = useData((s) => s.state, store);
  const settings = getSettingsStore();
  const { breakTime, strictAttribution } = useSyncExternalStore(
    settings.subscribe,
    settings.getSnapshot,
    settings.getSnapshot,
  );
  // Re-render when the lighting setting changes; `nightAt` reads it.
  useLighting((s) => s.setting);
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!breakTime) return;
    const timer = setInterval(() => setTick((n) => n + 1), TICK_MS);
    return () => clearInterval(timer);
  }, [breakTime]);

  const next = planBreaks(
    planInputs({
      now: store.now(),
      enabled: breakTime,
      night: nightAt,
      layout,
      agents: agents as readonly Agent[],
      activity: state?.activity ?? {},
      attention: plannerAttention(attention, strictAttribution),
      sessions: state?.sessions ?? {},
    }),
  );
  const kept = useRef(next);
  if (!samePlan(kept.current, next)) kept.current = next;
  return kept.current;
}
