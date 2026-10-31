import { Canvas } from "@react-three/fiber";
import type { Mesh, Object3D, Scene } from "three";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AgentsLayer } from "./AgentsLayer.tsx";
import type { AgentView } from "./types.ts";

function agent(over: Partial<AgentView> & { id: string }, x: number): AgentView {
  return {
    kind: "session",
    activity: "idle",
    placement: { x, y: 0, z: 0, heading: 0 },
    ...over,
  };
}

const AGENTS: AgentView[] = [
  agent({ id: "a1", displayName: "Ada", activity: "implementing" }, -2.2),
  agent({ id: "a2", displayName: "Grace", activity: "testing" }, -1.1),
  agent({ id: "a3", displayName: "Linus", activity: "researching" }, 0),
  agent({ id: "a4", displayName: "Barbara", attention: { level: "needs_you" } }, 1.1),
  agent(
    {
      id: "a5",
      kind: "subagent",
      depth: 1,
      agentType: "Explore",
      displayName: "explorer",
      activity: "researching",
    },
    2.2,
  ),
];

describe("AgentsLayer", () => {
  it("draws every agent from pooled geometry, and captures a screenshot for the task report", async () => {
    let scene: Scene | undefined;
    await render(
      <div data-testid="stage" style={{ width: 400, height: 260 }}>
        <Canvas
          camera={{ position: [0, 2.3, 4.6], fov: 40 }}
          onCreated={(state) => {
            state.camera.lookAt(0, 0.8, 0);
            scene = state.scene;
          }}
        >
          <color attach="background" args={["#11141a"]} />
          <ambientLight intensity={1.4} />
          <directionalLight position={[3, 6, 5]} intensity={1.2} />
          <gridHelper args={[12, 12, "#3a4558", "#252c38"]} />
          <AgentsLayer agents={AGENTS} reducedMotion />
        </Canvas>
      </div>,
    );
    await vi.waitFor(() => expect(scene).toBeDefined());
    const groups: Object3D[] = [];
    const geometries = new Set<string>();
    const sprites: Object3D[] = [];
    scene?.traverse((o) => {
      if (o.userData.agentId !== undefined) groups.push(o);
      if (o.type === "Sprite") sprites.push(o);
      if (o.type === "Mesh") geometries.add((o as Mesh).geometry.uuid);
    });
    expect(groups.map((g) => g.userData.agentId)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(sprites).toHaveLength(5);
    // Five agents share one set of body geometries (plus the grid helper is not a Mesh).
    expect(geometries.size).toBeLessThanOrEqual(9);
    expect(groups[4]?.scale.x).toBeCloseTo(0.6);
    await new Promise((r) => setTimeout(r, 400));
    await page
      .getByTestId("stage")
      .screenshot({ path: "../../../../../docs/tasks/M3.05/agents.png" });
  });
});
