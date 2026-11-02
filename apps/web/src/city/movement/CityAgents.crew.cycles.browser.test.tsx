import { Canvas, type RootState } from "@react-three/fiber";
import type { Mesh, Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../test/data/fake-engine.ts";
import { type Agent, initialState, type ProjectState } from "../../data/domain.ts";
import { createDataStore } from "../../data/store.ts";
import { createAnchorSource } from "../../overlays/host/index.ts";
import { SubagentCrew } from "../crew/subagents/SubagentCrew.tsx";
import { CityAgents } from "./CityAgents.tsx";

// The block agents and the crew layer together, over one store: every agent is drawn exactly once.
//  - Subagents that name each other as parent have no door to walk out of: each is drawn once, as
//    a block agent, never zero times (M5.02 round 5).
//  - A crew subagent whose parent leaves the store is drawn once, as a block agent.
// A block agent is nine meshes; a crew bot is three (body, trim, result cube).

const FRAME_WAIT = { timeout: 10_000 };
const T = "2026-10-31T10:00:00.000Z";

function agent(id: string, extra: Partial<Agent> = {}): Agent {
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

const sub = (id: string, parentAgentId: string): Agent =>
  agent(id, { kind: "subagent", parentAgentId, role: "Explore" });

const LEAD = agent("lead", { kind: "lead" });

function stateOf(agents: readonly Agent[]): ProjectState {
  return {
    ...initialState(PROJECT),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
  } as unknown as ProjectState;
}

async function mount(agents: readonly Agent[]) {
  const store = createDataStore({ now: () => 0 });
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(stateOf(agents));
  const anchors = createAnchorSource();
  let root: RootState | undefined;
  const screen = await render(
    <div style={{ width: 240, height: 180 }}>
      <Canvas
        camera={{ position: [0, 3, 6], fov: 40 }}
        onCreated={(s) => {
          root = s;
        }}
      >
        <CityAgents store={store} anchors={anchors} reducedMotion={true} />
        <SubagentCrew store={store} anchors={anchors} reducedMotion={true} />
      </Canvas>
    </div>,
  );
  await vi.waitFor(() => expect(root).toBeDefined(), FRAME_WAIT);
  // What the renderer draws: the agent's group and every group above it are visible.
  const drawings = (id: string): Object3D[] => {
    const found: Object3D[] = [];
    root?.scene.traverse((o) => {
      if (o.userData.agentId !== id) return;
      for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return;
      found.push(o);
    });
    return found;
  };
  const meshesIn = (o: Object3D): number => {
    let n = 0;
    o.traverse((c) => {
      if ((c as Mesh).isMesh === true) n++;
    });
    return n;
  };
  const frames = async (n: number): Promise<void> => {
    const target = (root?.gl.info.render.frame ?? 0) + n;
    await vi.waitFor(
      () => expect(root?.gl.info.render.frame).toBeGreaterThanOrEqual(target),
      FRAME_WAIT,
    );
  };
  const isBlockAgent = (id: string): boolean => {
    const [only] = drawings(id);
    return only !== undefined && meshesIn(only) > 3;
  };
  return {
    store,
    drawings,
    frames,
    isBlockAgent,
    set: (next: readonly Agent[]) => store.getState().applySnapshotState(stateOf(next)),
    unmount: () => screen.unmount(),
  };
}

describe("every agent is drawn exactly once", () => {
  it("draws subagents that name each other as parent once each, as block agents", async () => {
    const scene = await mount([LEAD, sub("kid", "lead"), sub("p", "q"), sub("q", "p")]);
    try {
      await vi.waitFor(() => expect(scene.drawings("lead")).toHaveLength(1), FRAME_WAIT);
      await vi.waitFor(() => expect(scene.drawings("kid")).toHaveLength(1), FRAME_WAIT);
      await vi.waitFor(() => expect(scene.drawings("p")).toHaveLength(1), FRAME_WAIT);
      await vi.waitFor(() => expect(scene.drawings("q")).toHaveLength(1), FRAME_WAIT);
      await scene.frames(5);
      for (const id of ["lead", "kid", "p", "q"]) expect(scene.drawings(id), id).toHaveLength(1);
      expect(scene.isBlockAgent("p")).toBe(true);
      expect(scene.isBlockAgent("q")).toBe(true);
      // The ordinary subagent is still a crew bot.
      expect(scene.isBlockAgent("kid")).toBe(false);
    } finally {
      await scene.unmount();
    }
  }, 30_000);

  it("draws a crew subagent once, as a block agent, when its parent leaves the store", async () => {
    const scene = await mount([LEAD, sub("kid", "lead")]);
    try {
      await vi.waitFor(() => expect(scene.drawings("kid")).toHaveLength(1), FRAME_WAIT);
      await scene.frames(3);
      expect(scene.isBlockAgent("kid")).toBe(false);

      // The lead leaves; its parent id is now unknown to the store.
      scene.set([sub("kid", "lead")]);
      await vi.waitFor(() => expect(scene.isBlockAgent("kid")).toBe(true), FRAME_WAIT);
      await scene.frames(5);
      expect(scene.drawings("kid")).toHaveLength(1);
      expect(scene.isBlockAgent("kid")).toBe(true);
    } finally {
      await scene.unmount();
    }
  }, 30_000);
});
