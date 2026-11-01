import { useFrame, useThree } from "@react-three/fiber";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { useData } from "../../data/react.ts";
import { type DataStore, dataStore } from "../../data/store.ts";
import { type AnchorSource, worldAnchors } from "../../overlays/host/index.ts";
import { debugHookRequested } from "../../testHooks.ts";
import { AgentsLayer } from "../agents/index.ts";
import type { AgentLabelEntry, AgentView, Placement } from "../agents/types.ts";
import { presentationEpoch } from "../runtime/epoch.ts";
import { rebuildPresentation } from "../runtime/rebuild.ts";
import { agentAnchorId } from "./AgentLabels.tsx";
import { type LabelStore, labelRows, movementLabels } from "./labels.ts";
import { buildModels } from "./models.ts";
import { createNavigator, type Navigator, type PresentationState } from "./navigator.ts";
import { loadActivityAreas, usePrefersReducedMotion } from "./settings.ts";

export interface CityAgentsProps {
  store?: DataStore;
  anchors?: AnchorSource;
  labels?: LabelStore;
  /** Overrides the system preference (the settings panel will pass its own). */
  reducedMotion?: boolean;
}

function localStorageOrNull(): Storage | null {
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

/** `?debug=movement` exposes a read-only snapshot of navigation for end-to-end checks. */
function debugEnabled(): boolean {
  try {
    return debugHookRequested(window.location.search, "movement");
  } catch {
    return false;
  }
}

/**
 * The store's agents in the city: maps them to block agents, walks them with the navigator, and
 * publishes their labels (world-labels slot) and label anchors. Mounted inside the `<Canvas>`.
 */
export function CityAgents({
  store = dataStore,
  anchors = worldAnchors,
  labels = movementLabels,
  reducedMotion,
}: CityAgentsProps) {
  const state = useData((s) => s.state, store);
  const agents = useData((s) => s.agents, store);
  const attention = useData((s) => s.attention, store);
  const prefersReduced = usePrefersReducedMotion();
  const reduced = reducedMotion ?? prefersReduced;

  const navRef = useRef<Navigator | null>(null);
  if (navRef.current === null) navRef.current = createNavigator();
  const nav = navRef.current;
  useEffect(() => nav.setReducedMotion(reduced), [nav, reduced]);

  // Back from a long absence the walkers snap to where their paths end (ARCHITECTURE.md 2.8).
  const clock = useThree((s) => s.clock);
  const epoch = useSyncExternalStore(
    presentationEpoch.subscribe,
    presentationEpoch.getSnapshot,
    presentationEpoch.getSnapshot,
  );
  const seenEpoch = useRef(epoch.epoch);
  useEffect(() => {
    if (seenEpoch.current === epoch.epoch) return;
    seenEpoch.current = epoch.epoch;
    rebuildPresentation(nav, clock.getElapsedTime() * 1000, reduced, epoch.hiddenForMs);
  }, [epoch, nav, clock, reduced]);

  const table = useMemo(() => loadActivityAreas(localStorageOrNull()), []);
  const placements = useRef(new Map<string, Placement>());
  const placementFor = useCallback((id: string) => {
    let p = placements.current.get(id);
    if (p === undefined) {
      p = { x: 0, y: 0, z: 0, heading: 0 };
      placements.current.set(id, p);
    }
    return p;
  }, []);

  const activity = state?.activity;
  const models = useMemo(
    () =>
      activity === undefined
        ? null
        : buildModels({ agents, activity, attention }, table, placementFor),
    [agents, activity, attention, table, placementFor],
  );

  // A departing bot keeps its last look until it has walked out of the city.
  const lastViews = useRef(new Map<string, AgentView>());
  const [pruned, setPruned] = useState(0);
  // biome-ignore lint/correctness/useExhaustiveDependencies: `pruned` re-runs this after departed bots are dropped from the ref
  const views = useMemo(() => {
    if (models === null) return [];
    const live = new Set<string>();
    for (const v of models.views) {
      live.add(v.id);
      lastViews.current.set(v.id, v);
    }
    const leaving = [...lastViews.current.values()].filter((v) => !live.has(v.id));
    return [...models.views, ...leaving];
  }, [models, pruned]);

  const entries = useRef<readonly AgentLabelEntry[]>([]);
  const offsets = useRef(new Map<string, number>());
  const urgent = useRef<ReadonlySet<string>>(new Set());
  const shown = useRef(new Map<string, { state: PresentationState; onTheWay: boolean }>());
  const anchorPoint = useRef<[number, number, number]>([0, 0, 0]);

  const publishLabels = useCallback(() => {
    labels.set(labelRows(entries.current, (id) => nav.get(id), urgent.current));
  }, [labels, nav]);

  const publishPositions = useCallback(() => {
    const point = anchorPoint.current;
    for (const a of nav.list()) {
      const p = placementFor(a.id);
      p.x = a.x;
      p.z = a.z;
      p.heading = a.heading;
      point[0] = p.x;
      point[1] = p.y + (offsets.current.get(a.id) ?? 0);
      point[2] = p.z;
      anchors.setAnchor(agentAnchorId(a.id), point);
    }
  }, [nav, anchors, placementFor]);

  const onLabels = useCallback(
    (next: readonly AgentLabelEntry[]) => {
      entries.current = next;
      offsets.current = new Map(next.map((e) => [e.id, e.offsetY]));
      publishLabels();
    },
    [publishLabels],
  );

  // Before paint, so the first frame already draws every bot where navigation put it.
  const placedOnce = useRef(false);
  useLayoutEffect(() => {
    if (models === null) return;
    nav.sync(models.intents, { place: !placedOnce.current });
    placedOnce.current = true;
    urgent.current = new Set(
      models.views.filter((v) => v.attention?.level === "needs_you").map((v) => v.id),
    );
    publishPositions();
    publishLabels();
  }, [models, nav, publishPositions, publishLabels]);

  useEffect(
    () => () => {
      anchors.replaceAnchors("agent:", {});
      labels.set([]);
    },
    [anchors, labels],
  );

  useEffect(() => {
    if (import.meta.env.VITE_TV_TEST_HOOKS !== "1" || !debugEnabled()) return;
    const w = window as unknown as { __taskvilleMovement?: () => unknown };
    w.__taskvilleMovement = () => nav.list().map((a) => ({ ...a }));
    return () => {
      delete w.__taskvilleMovement;
    };
  }, [nav]);

  // Priority -1: runs before the bots' own frame callbacks read their placement.
  useFrame((frame) => {
    nav.tick(frame.clock.elapsedTime * 1000);
    publishPositions();
    let changed = false;
    let gone = false;
    for (const a of nav.list()) {
      const before = shown.current.get(a.id);
      if (before === undefined || before.state !== a.state || before.onTheWay !== a.onTheWay) {
        shown.current.set(a.id, { state: a.state, onTheWay: a.onTheWay });
        changed = true;
      }
      if (a.gone) gone = true;
    }
    if (changed) publishLabels();
    if (!gone) return;
    for (const a of nav.list()) {
      if (!a.gone) continue;
      lastViews.current.delete(a.id);
      placements.current.delete(a.id);
      shown.current.delete(a.id);
      anchors.removeAnchor(agentAnchorId(a.id));
    }
    nav.prune();
    setPruned((n) => n + 1);
  }, -1);

  return <AgentsLayer agents={views} reducedMotion={reduced} onLabels={onLabels} now={store.now} />;
}
