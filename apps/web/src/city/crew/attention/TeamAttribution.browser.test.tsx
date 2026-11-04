import { Canvas, type RootState } from "@react-three/fiber";
import type { Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../../test/data/fake-engine.ts";
import { type Agent, initialState, type ProjectState } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import type { AgentView } from "../../agents/types.ts";
import { TeamAttribution } from "./TeamAttribution.tsx";

// M5.21 (#334): a mount-level pin that a teammate's stuck subagent puts a red dot on the team
// lead. The unit tests cover `leadDotTargets`; this checks the mounted TeamAttribution draws it
// (the dot is the scene object with `userData.needsYouDot = <lead id>`).

const WAIT = { timeout: 10_000 };
const T = "2026-11-01T10:00:00.000Z";

const agent = (id: string, extra: Partial<Agent>): Agent =>
  ({
    id,
    sourceId: "demo:7",
    sourceAgentId: id,
    displayName: id,
    kind: "session",
    registered: true,
    connection: "connected",
    firstSeenAt: T,
    lastSeenAt: T,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
    ...extra,
  }) as Agent;

const agents = [
  agent("lead", { kind: "lead", teamId: "t1" }),
  agent("pip", { kind: "teammate", teamId: "t1" }),
  agent("scout", { kind: "subagent", parentAgentId: "pip", role: "Explore" }),
];

const view = (id: string, kind: AgentView["kind"]): AgentView =>
  ({
    id,
    kind,
    activity: "idle",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
  }) as unknown as AgentView;

function stateWithStuck(agentId: string | null): ProjectState {
  return {
    ...initialState(PROJECT),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
    teams: { t1: { id: "t1", leadAgentId: "lead" } },
    requests:
      agentId === null
        ? {}
        : {
            r0: {
              id: "r0",
              agentId,
              kind: "permission",
              answerable: false,
              openedAt: T,
              state: "open",
              late: false,
              mergedRequestIds: [],
            },
          },
  } as unknown as ProjectState;
}

async function stage(stuckAgent: string | null) {
  const store = createDataStore({ now: () => Date.parse(T) + 1000 });
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(stateWithStuck(stuckAgent));
  let root: RootState | undefined;
  const screen = await render(
    <div style={{ width: 240, height: 180 }}>
      <Canvas
        onCreated={(s) => {
          root = s;
        }}
      >
        <TeamAttribution
          store={store}
          views={[view("lead", "lead"), view("pip", "teammate"), view("scout", "subagent")]}
        />
      </Canvas>
    </div>,
  );
  await vi.waitFor(() => expect(root).toBeDefined(), WAIT);
  const dotsOn = (owner: string): Object3D[] => {
    const found: Object3D[] = [];
    root?.scene.traverse((o) => {
      if (o.userData.needsYouDot === owner) found.push(o);
    });
    return found;
  };
  return { screen, dotsOn, store };
}

describe("TeamAttribution mounted over a team with a subagent under a teammate", () => {
  it("puts a dot on the lead when the teammate's subagent needs you", async () => {
    const s = await stage("scout");
    try {
      await vi.waitFor(() => expect(s.dotsOn("lead")).toHaveLength(1), WAIT);
    } finally {
      await s.screen.unmount();
    }
  });

  it("draws no lead dot when nothing needs you", async () => {
    const s = await stage(null);
    try {
      await new Promise((r) => setTimeout(r, 300));
      expect(s.dotsOn("lead")).toHaveLength(0);
    } finally {
      await s.screen.unmount();
    }
  });
});
