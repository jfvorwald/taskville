import { Canvas, type RootState } from "@react-three/fiber";
import type { Mesh, Object3D, Scene, Sprite } from "three";
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

// The task-report screenshot is written only on request: `VITE_TV_CAPTURE=1` (Vite only passes
// `VITE_`-prefixed variables to browser tests; plain `TV_CAPTURE=1` is also honored if the
// browser config ever forwards it). A normal run must not touch the working tree.
const CAPTURE = import.meta.env.VITE_TV_CAPTURE === "1" || import.meta.env.TV_CAPTURE === "1";

describe("AgentsLayer", () => {
  it("draws every agent from pooled geometry, and captures a screenshot for the task report", async () => {
    let scene: Scene | undefined;
    let root: RootState | undefined;
    await render(
      <div data-testid="stage" style={{ width: 400, height: 260 }}>
        <Canvas
          camera={{ position: [0, 2.3, 4.6], fov: 40 }}
          onCreated={(state) => {
            state.camera.lookAt(0, 0.8, 0);
            scene = state.scene;
            root = state;
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
    // Wait on conditions, not time: a few frames rendered and every label texture drawn.
    await vi.waitFor(() => expect(root?.gl.info.render.frame).toBeGreaterThan(3));
    await vi.waitFor(() => {
      const versions: number[] = [];
      scene?.traverse((o) => {
        if (o.type === "Sprite") versions.push((o as Sprite).material.map?.version ?? 0);
      });
      expect(versions).toHaveLength(5);
      expect(versions.every((v) => v >= 1)).toBe(true);
    });
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
    if (CAPTURE) {
      await page
        .getByTestId("stage")
        .screenshot({ path: "../../../../../docs/tasks/M3.05/agents.png" });
    }
  });

  it("freezes the work-loop pose under reduced motion and animates it otherwise", async () => {
    const worker = (): AgentView[] => [
      agent({ id: "w1", displayName: "Ada", activity: "implementing" }, 0),
    ];
    const stage = async (reducedMotion: boolean) => {
      let state: RootState | undefined;
      const screen = await render(
        <div style={{ width: 200, height: 150 }}>
          <Canvas
            camera={{ position: [0, 1.5, 3], fov: 40 }}
            onCreated={(s) => {
              state = s;
            }}
          >
            <AgentsLayer agents={worker()} reducedMotion={reducedMotion} />
          </Canvas>
        </div>,
      );
      await vi.waitFor(() => expect(state?.clock.elapsedTime).toBeGreaterThan(0.1));
      return { state: state as RootState, screen };
    };
    /** Arm swing angles (every child group of the agent root: the two shoulders), per sample. */
    const sampleArms = async (state: RootState, ms: number) => {
      const body = state.scene.children.find((o) => o.userData.agentId === "w1");
      expect(body).toBeDefined();
      const t0 = state.clock.elapsedTime;
      const samples: number[][] = [];
      const until = performance.now() + ms;
      while (performance.now() < until) {
        samples.push(
          (body?.children ?? []).filter((c) => c.type === "Group").map((c) => c.rotation.x),
        );
        await new Promise((r) => setTimeout(r, 20));
      }
      return { samples, clockAdvance: state.clock.elapsedTime - t0 };
    };
    const spread = (samples: number[][]) => {
      const cols = samples[0]?.length ?? 0;
      let widest = 0;
      for (let c = 0; c < cols; c++) {
        const col = samples.map((row) => row[c] ?? 0);
        widest = Math.max(widest, Math.max(...col) - Math.min(...col));
      }
      return widest;
    };

    const still = await stage(true);
    const frozen = await sampleArms(still.state, 800);
    await still.screen.unmount();
    // The clock ran (so frames did too), the arms are posed, and nothing moved.
    expect(frozen.clockAdvance).toBeGreaterThan(0.5);
    expect(frozen.samples[0]?.some((x) => Math.abs(x) > 0.5)).toBe(true);
    expect(spread(frozen.samples)).toBeLessThan(1e-9);

    const moving = await stage(false);
    const live = await sampleArms(moving.state, 800);
    await moving.screen.unmount();
    expect(live.clockAdvance).toBeGreaterThan(0.5);
    // The hammer arm swings through about 1.8 rad per loop; 0.8 s covers most of a 1.2 s loop.
    expect(spread(live.samples)).toBeGreaterThan(0.5);
  });
});
