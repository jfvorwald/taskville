import { Canvas, type RootState } from "@react-three/fiber";
import type { Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../test/data/fake-engine.ts";
import { type Agent, initialState, type ProjectState } from "../../data/domain.ts";
import { createDataStore } from "../../data/store.ts";
import { createAnchorSource } from "../../overlays/host/index.ts";
import { SubagentCrew } from "../crew/subagents/SubagentCrew.tsx";
import { CityAgents } from "./CityAgents.tsx";

// One drawing per subagent (roborev 6395 finding 1): a subagent whose parent is not known is
// drawn as a block agent. When the parent shows up, the subagent becomes a crew bot, and the
// block agent that was cached for it must go: the scene never holds two drawings of it.

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

const LEAD = agent("lead", { kind: "lead" });
const KID = agent("kid", { kind: "subagent", parentAgentId: "lead", role: "Explore" });

function stateOf(agents: readonly Agent[]): ProjectState {
  return {
    ...initialState(PROJECT),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
  } as unknown as ProjectState;
}

describe("a subagent that gains a known parent", () => {
  it("is drawn once, as a crew bot only, with no cached block agent left behind", async () => {
    const store = createDataStore({ now: () => 0 });
    store.getState().reset(PROJECT);
    // The parent is not in the store yet: `kid` is a block agent.
    store.getState().applySnapshotState(stateOf([KID]));
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
    const drawings = (id: string): Object3D[] => {
      const found: Object3D[] = [];
      root?.scene.traverse((o) => {
        if (o.userData.agentId === id) found.push(o);
      });
      return found;
    };
    const frames = async (n: number): Promise<void> => {
      const target = (root?.gl.info.render.frame ?? 0) + n;
      await vi.waitFor(
        () => expect(root?.gl.info.render.frame).toBeGreaterThanOrEqual(target),
        FRAME_WAIT,
      );
    };
    try {
      await vi.waitFor(() => expect(drawings("kid")).toHaveLength(1), FRAME_WAIT);
      await frames(3);

      // The parent arrives.
      store.getState().applySnapshotState(stateOf([LEAD, KID]));
      await vi.waitFor(() => expect(drawings("lead")).toHaveLength(1), FRAME_WAIT);
      // The block agent for `kid` goes, the crew bot is the only drawing left.
      await vi.waitFor(() => expect(drawings("kid")).toHaveLength(1), FRAME_WAIT);
      await frames(5);
      expect(drawings("kid")).toHaveLength(1);
    } finally {
      await screen.unmount();
    }
  }, 30_000);
});
