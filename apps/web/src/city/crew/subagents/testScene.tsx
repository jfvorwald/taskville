import { Canvas, type RootState } from "@react-three/fiber";
import type { ReactNode } from "react";
import type { Mesh, Object3D, Sprite, SpriteMaterial } from "three";
import { Vector3 } from "three";
import { expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../../test/data/fake-engine.ts";
import { type Agent, initialState, type ProjectState } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../../overlays/host/index.ts";
import { createCameraRig } from "../../interaction/cameraRig.ts";
import { InteractionLayer } from "../../interaction/InteractionLayer.tsx";
import { createSelectionStore } from "../../interaction/selection.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { SubagentCrew } from "./SubagentCrew.tsx";

// A shared harness for the M5.02 browser tests: the crew layer in a real R3F scene over a store
// with an injectable clock. Not a test file itself.

export const FRAME_WAIT = { timeout: 10_000 };
export const T = "2026-10-31T10:00:00.000Z";
/** A clock reading at which every subagent started at 0 is working at its spot. */
export const WORKING_MS = 10_000;

export function agent(id: string, extra: Partial<Agent> = {}): Agent {
  return {
    id,
    sourceId: "demo:7",
    sourceAgentId: id,
    displayName: id.toUpperCase(),
    kind: "session",
    registered: true,
    connection: "connected",
    firstSeenAt: T,
    lastSeenAt: T,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
    ...extra,
  } as Agent;
}

export const sub = (id: string, parentAgentId: string, extra: Partial<Agent> = {}): Agent =>
  agent(id, { kind: "subagent", parentAgentId, role: "Explore", ...extra });

export const LEAD = agent("lead", { kind: "lead" });

/** The state for `agents`, with an open permission request (so: needs you) for each of `needsYou`. */
export function stateOf(agents: readonly Agent[], needsYou: readonly string[] = []): ProjectState {
  return {
    ...initialState(PROJECT),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    requests: Object.fromEntries(
      needsYou.map((agentId, i) => [
        `r${i}`,
        {
          id: `r${i}`,
          agentId,
          kind: "permission",
          answerable: false,
          openedAt: T,
          state: "open",
          late: false,
          mergedRequestIds: [],
        },
      ]),
    ),
  } as unknown as ProjectState;
}

export interface MountOptions {
  /** The lead's anchor; null leaves the lead without one. Default [2, 0, 3]. */
  anchor?: [number, number, number] | null;
  reducedMotion?: boolean;
  needsYou?: readonly string[];
  /** Mount the real `InteractionLayer` next to the crew (pointer tests). */
  interaction?: boolean;
  /** Canvas size in px. */
  size?: [number, number];
  /** Spies: the store's clock and the anchor source are wrapped when given. */
  onNow?: () => void;
  onGetAnchor?: () => void;
  /** Runs on the store before anything is rendered (to wrap `subscribe`, say). */
  wrapStore?: (store: ReturnType<typeof createDataStore>) => void;
}

export interface Scene {
  root: () => RootState;
  clock: { now: number };
  store: ReturnType<typeof createDataStore>;
  anchors: ReturnType<typeof createAnchorSource>;
  selection: ReturnType<typeof createSelectionStore>;
  set(agents: readonly Agent[], needsYou?: readonly string[]): void;
  bot(id: string): Object3D | undefined;
  shown(id: string): boolean;
  /** World position of an object. */
  at(o: Object3D): Vector3;
  /** Every object in the scene that satisfies `test`. */
  find(test: (o: Object3D) => boolean): Object3D[];
  /** The shown sprites whose material is one of `materials`. */
  spritesOf(materials: readonly SpriteMaterial[]): Sprite[];
  /** The shown objects that mark `owner` with a red dot (`userData.needsYouDot === owner`). */
  dotsOn(owner: string): Object3D[];
  frames(n: number): Promise<void>;
  unmount(): Promise<void>;
  /** Replaces what the canvas draws with nothing, keeping the canvas and its frame loop. */
  removeLayer(): Promise<void>;
}

export const isShown = (o: Object3D): boolean => {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  return true;
};

export async function mount(agents: readonly Agent[], options: MountOptions = {}): Promise<Scene> {
  const clock = { now: 0 };
  const store = createDataStore({
    now: () => {
      options.onNow?.();
      return clock.now;
    },
  });
  options.wrapStore?.(store);
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(stateOf(agents, options.needsYou));
  const inner = createAnchorSource();
  const anchors =
    options.onGetAnchor === undefined
      ? inner
      : Object.assign(Object.create(inner) as typeof inner, {
          getAnchor: (id: string) => {
            options.onGetAnchor?.();
            return inner.getAnchor(id);
          },
        });
  const anchor =
    options.anchor === undefined ? ([2, 0, 3] as [number, number, number]) : options.anchor;
  if (anchor !== null) inner.setAnchor(agentAnchorId("lead"), anchor);
  const selection = createSelectionStore();
  const rig = createCameraRig();
  const [width, height] = options.size ?? [240, 180];

  let captured: RootState | undefined;
  const layer = (
    <>
      {options.interaction === true && (
        <InteractionLayer store={selection} rig={rig} reducedMotion />
      )}
      <SubagentCrew
        store={store}
        anchors={anchors}
        reducedMotion={options.reducedMotion ?? false}
      />
    </>
  );
  const view = (children: ReactNode) => (
    <div style={{ width, height }}>
      <Canvas
        camera={{ position: [0, 3, 6], fov: 40 }}
        onCreated={(s) => {
          captured = s;
        }}
      >
        {children}
      </Canvas>
    </div>
  );
  const screen = await render(view(layer));
  await vi.waitFor(() => expect(captured).toBeDefined(), FRAME_WAIT);
  const root = (): RootState => {
    if (captured === undefined) throw new Error("scene not created");
    return captured;
  };
  const find = (test: (o: Object3D) => boolean): Object3D[] => {
    const found: Object3D[] = [];
    root().scene.traverse((o) => {
      if (test(o)) found.push(o);
    });
    return found;
  };
  const bot = (id: string): Object3D | undefined => find((o) => o.userData.agentId === id)[0];
  const shown = (id: string): boolean => {
    const b = bot(id);
    return b !== undefined && isShown(b);
  };
  const frames = async (n: number): Promise<void> => {
    const target = root().gl.info.render.frame + n;
    await vi.waitFor(
      () => expect(root().gl.info.render.frame).toBeGreaterThanOrEqual(target),
      FRAME_WAIT,
    );
  };
  return {
    root,
    clock,
    store,
    anchors,
    selection,
    set: (next, needsYou) => store.getState().applySnapshotState(stateOf(next, needsYou)),
    bot,
    shown,
    at: (o) => o.getWorldPosition(new Vector3()),
    find,
    spritesOf: (materials) =>
      find(
        (o) =>
          (o as Sprite).isSprite === true &&
          materials.includes((o as Sprite).material) &&
          isShown(o),
      ) as Sprite[],
    dotsOn: (owner) => find((o) => o.userData.needsYouDot === owner && isShown(o)),
    frames,
    unmount: () => screen.unmount(),
    removeLayer: async () => {
      await screen.rerender(view(null));
    },
  };
}

/** The body mesh of a crew bot (the first mesh in its group), and its trim. */
export function partsOf(bot: Object3D): { body: Mesh; trim: Mesh } {
  const meshes = bot.children.filter((c): c is Mesh => (c as Mesh).isMesh === true);
  return { body: meshes[0] as Mesh, trim: meshes[1] as Mesh };
}

/** Horizontal distance between two world points. */
export const flatDistance = (a: Vector3, b: { x: number; z: number }): number =>
  Math.hypot(a.x - b.x, a.z - b.z);
