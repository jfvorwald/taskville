import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
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
  activity: Readonly<Record<string, { activity: string; since?: string } | undefined>>;
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
    const entry = source.activity[agent.id];
    const rest = restOf(level, entry?.activity);
    // An idle agent with no waiting record is seeded from the activity's own `since`.
    const seed = record?.level !== "waiting" && rest === "idle" ? entry?.since : undefined;
    const since = Date.parse(record?.level === "waiting" ? record.since : (seed ?? ""));
    agents.push({
      id: agent.id,
      rest,
      level,
      waitingEventId:
        record?.level === "waiting"
          ? (record.requestId ?? `${record.kind}@${record.since}`)
          : seed === undefined
            ? null
            : `activity@${seed}`,
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
  const lighting = useLighting((s) => s.setting);
  const [tick, setTick] = useState(0);
  const kept = useRef<BreakPlan | null>(null);
  // The plan for a moment, from the latest render's inputs; the tick below samples it too.
  const build = (at: number): BreakPlan =>
    planBreaks(
      planInputs({
        now: at,
        enabled: breakTime,
        night: nightAt,
        layout,
        agents: agents as readonly Agent[],
        activity: state?.activity ?? {},
        attention: plannerAttention(attention, strictAttribution),
        sessions: state?.sessions ?? {},
      }),
    );
  const latest = useRef(build);
  latest.current = build;
  // M9.13: the tick samples the plan outside React and re-renders consumers only when it changed,
  // so an idle tick costs no render and no frame. The clock is read here, in a timer callback,
  // not during render.
  useEffect(() => {
    if (!breakTime) return;
    const timer = setInterval(() => {
      const sampled = latest.current(store.now());
      if (kept.current === null || !samePlan(kept.current, sampled)) setTick((n) => n + 1);
    }, TICK_MS);
    return () => clearInterval(timer);
  }, [breakTime, store]);

  // The clock is read only when a tracked input changes (a changed tick, a store slice, a setting),
  // never on any other render. React may render a component for a state update that turns out to
  // change nothing (Bubbles' no-op setState), then bail out: it keeps that render's hook state but
  // drops its effects. A plan that changed in such a render, only because the clock moved, would
  // reach the consumers' memo and effect deps without their effects ever running for it (M9.14).
  // biome-ignore lint/correctness/useExhaustiveDependencies: the deps are the re-sample signals
  const now = useMemo(
    () => store.now(),
    [store, tick, agents, attention, state, breakTime, strictAttribution, lighting],
  );

  const next = build(now);
  if (kept.current === null || !samePlan(kept.current, next)) kept.current = next;
  return kept.current;
}
