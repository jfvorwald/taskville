import { Canvas, type RootState } from "@react-three/fiber";
import type { ReactNode } from "react";
import type { Object3D, Sprite } from "three";
import { expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../test/data/fake-engine.ts";
import { type Agent, initialState, type ProjectState } from "../../data/domain.ts";
import { createDataStore, type DataStore } from "../../data/store.ts";
import { createAnchorSource } from "../../overlays/host/anchors.ts";
import type { AnchorSource, OverlayProps } from "../../overlays/host/types.ts";
import type { Emote } from "../attention/emote.ts";
import { emoteMaterial } from "../attention/resources.ts";
import { CITY_LAYOUT } from "../layout/index.ts";
import { CityAgents } from "../movement/CityAgents.tsx";
import { createLabelStore, type LabelStore } from "../movement/labels.ts";
import { planBreaks } from "./plan.ts";
import type { AgentBreak, BreakPlan } from "./types.ts";
import { planInputs } from "./usePlan.ts";

// Shared setup for the M9.08 browser tests: a city over a data store whose clock the test moves,
// agents that sit at their workstations first and then turn Waiting, and read-outs of where each
// agent stands (its published anchor), what its label says and which emote sprite it carries.
// Reduced motion is on, so walks snap: a trip is over as soon as the break plan changes.

export const FRAME_WAIT = { timeout: 10_000 };
export const T_MS = Date.parse("2026-10-31T10:00:00.000Z");
export const SECOND = 1000;
export const iso = (ms: number) => new Date(ms).toISOString();
/** When every waiting agent's turn ended (its waiting record starts here). */
export const WAITING_SINCE = T_MS + SECOND;

/** Maps world meters to the viewport: x to the right, z down, 18 px per meter on a 900x600 view. */
const PROJECTION = [0.04, 0, 0, 0, 0, 0.04, 0, 0, 0, -0.04, 0.04, 0, 0, 0, 0, 1];
export const SIZE = { width: 900, height: 600 };

export function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    sourceId: "demo:7",
    sourceAgentId: id,
    displayName: id.toUpperCase(),
    kind: "session",
    registered: true,
    connection: "connected",
    firstSeenAt: iso(T_MS),
    lastSeenAt: iso(T_MS),
    toolCallCount: 0,
    consecutiveToolFailures: 0,
    ...extra,
  } as Agent;
}

export type Phase = "working" | "waiting";

/** The project state with every agent in `phase`; `needsYou` ids also hold an open permission request. */
export function stateOf(
  phases: Readonly<Record<string, Phase>>,
  needsYou: { ids: readonly string[]; openedAt: number } = { ids: [], openedAt: 0 },
): ProjectState {
  const ids = Object.keys(phases);
  const agents = Object.fromEntries(
    ids.map((id) => [
      id,
      phases[id] === "waiting"
        ? agent(id, { lastTurn: "ended", lastTurnAt: iso(WAITING_SINCE) })
        : agent(id),
    ]),
  );
  const activity = Object.fromEntries(
    ids.map((id) => [
      id,
      {
        agentId: id,
        activity: phases[id] === "waiting" ? "waiting" : "implementing",
        heuristic: false,
        since: iso(T_MS),
        openSessionCount: 1,
      },
    ]),
  );
  const requests = Object.fromEntries(
    needsYou.ids.map((id) => [
      `req-${id}`,
      {
        id: `req-${id}`,
        agentId: id,
        kind: "permission",
        answerable: false,
        openedAt: iso(needsYou.openedAt),
        state: "open",
        late: false,
        mergedRequestIds: [],
      },
    ]),
  );
  return { ...initialState(PROJECT), agents, activity, requests } as unknown as ProjectState;
}

export interface Harness {
  store: DataStore;
  clock: { now: number };
  anchors: AnchorSource;
  labels: LabelStore;
  root: () => RootState;
  /** Where the agent's anchor is, in meters. */
  at: (id: string) => { x: number; z: number } | undefined;
  /** Applies a project state (a store update, like a sync snapshot). */
  apply: (state: ProjectState) => void;
  frames: (n: number) => Promise<void>;
  /** Every pooled emote the agent's drawing currently carries. */
  emotesOf: (id: string) => Emote[];
  unmount: () => Promise<void>;
}

const EMOTES: readonly Emote[] = [
  "!",
  "?",
  "...",
  "zzz",
  "sweat",
  "puff",
  "mug",
  "sparkle",
  "note",
];

/** Renders the city (and `extra` DOM, such as the bubbles) over a store with a movable clock. */
export async function mountCity(
  initial: Readonly<Record<string, Phase>>,
  extra?: (h: { store: DataStore; anchors: AnchorSource; labels: LabelStore }) => ReactNode,
  options: { now?: number; reducedMotion?: boolean } = {},
): Promise<Harness> {
  const clock = { now: options.now ?? T_MS };
  const store = createDataStore({ now: () => clock.now });
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(stateOf(initial));
  const anchors = createAnchorSource();
  anchors.setProjection(PROJECTION, SIZE);
  const labels = createLabelStore();
  let root: RootState | undefined;
  const screen = await render(
    <div style={{ position: "relative", width: SIZE.width, height: SIZE.height }}>
      <div style={{ width: 240, height: 180 }}>
        <Canvas
          camera={{ position: [0, 3, 6], fov: 40 }}
          onCreated={(s) => {
            root = s;
          }}
        >
          <CityAgents
            store={store}
            anchors={anchors}
            labels={labels}
            reducedMotion={options.reducedMotion ?? true}
          />
        </Canvas>
      </div>
      {extra?.({ store, anchors, labels })}
    </div>,
  );
  const frames = async (n: number): Promise<void> => {
    const target = (root?.gl.info.render.frame ?? 0) + n;
    await vi.waitFor(
      () => expect(root?.gl.info.render.frame).toBeGreaterThanOrEqual(target),
      FRAME_WAIT,
    );
  };
  await vi.waitFor(() => expect(root).toBeDefined(), FRAME_WAIT);
  for (const id of Object.keys(initial)) {
    await vi.waitFor(() => expect(anchors.getAnchor(`agent:${id}`)).toBeDefined(), FRAME_WAIT);
  }
  await frames(3);
  const at = (id: string) => {
    const p = anchors.getAnchor(`agent:${id}`);
    return p === undefined ? undefined : { x: p[0], z: p[2] };
  };
  return {
    store,
    clock,
    anchors,
    labels,
    root: () => root as RootState,
    at,
    apply: (state) => store.getState().applySnapshotState(state),
    frames,
    emotesOf: (id) => {
      const group: Object3D | undefined = root?.scene.children.find(
        (o) => o.userData.agentId === id,
      );
      const sprites: Sprite[] = [];
      group?.traverse((o) => {
        if ((o as Sprite).isSprite === true) sprites.push(o as Sprite);
      });
      return EMOTES.filter((e) =>
        sprites.some((s) => s.visible && s.material === emoteMaterial(e)),
      );
    },
    unmount: () => screen.unmount(),
  };
}

export const dist = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

/** The plan a correct city shows for the store at `now` (the pure planner, always-day lighting). */
export function expectedPlan(store: DataStore, now: number): BreakPlan {
  const { agents, attention, state } = store.getState();
  return planBreaks(
    planInputs({
      now,
      enabled: true,
      night: false,
      layout: CITY_LAYOUT,
      agents,
      activity: state?.activity ?? {},
      attention,
      sessions: state?.sessions ?? {},
    }),
  );
}

/** Where a break stands in the world: the spot's node, or the plaza node of that index. */
export function breakPoint(b: AgentBreak): { x: number; z: number } {
  const nodes =
    b.siteId === null
      ? CITY_LAYOUT.graph.nodes.filter((n) => n.kind === "plaza")
      : (CITY_LAYOUT.breakSites
          .find((s) => s.id === b.siteId)
          ?.spots.map((s) => ({
            id: s.nodeId,
            x: s.x,
            z: s.z,
          })) ?? []);
  const node = nodes[b.spot];
  if (node === undefined) throw new Error(`no node for break ${b.siteId}:${b.spot}`);
  return { x: node.x, z: node.z };
}

export const plazaPoints = () =>
  CITY_LAYOUT.graph.nodes.filter((n) => n.kind === "plaza").map((n) => ({ x: n.x, z: n.z }));

/** Overlay props for the DOM overlays, over the harness anchors. */
export function overlayProps(
  anchors: AnchorSource,
  selectedId: string | null = null,
): OverlayProps {
  return {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId, select: () => {} },
    anchors,
    intents: { available: true, run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };
}
