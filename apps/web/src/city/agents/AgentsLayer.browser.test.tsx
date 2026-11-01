import { Canvas, type RootState } from "@react-three/fiber";
import type { Mesh, Object3D, Scene, Sprite } from "three";
import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { emoteMaterial } from "../attention/resources.ts";
import { AgentsLayer } from "./AgentsLayer.tsx";
import { LABEL_HEIGHT } from "./labelEntries.ts";
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

// The full browser suite runs files in parallel on software WebGL (SwiftShader), and a page can
// then go several seconds without a frame (4.6 s measured), so a frame-bound wait needs far more
// than `vi.waitFor`'s 1 s default. A healthy run still meets each condition in milliseconds.
const FRAME_WAIT = { timeout: 10_000 };

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
    await vi.waitFor(() => expect(scene).toBeDefined(), FRAME_WAIT);
    // Wait on conditions, not time: a few frames rendered and every label texture drawn.
    await vi.waitFor(() => expect(root?.gl.info.render.frame).toBeGreaterThan(3), FRAME_WAIT);
    await vi.waitFor(() => {
      const versions: number[] = [];
      scene?.traverse((o) => {
        if (o.type === "Sprite") versions.push((o as Sprite).material.map?.version ?? 0);
      });
      // Five local labels plus the one emote on the agent that needs the user.
      expect(versions).toHaveLength(6);
      expect(versions.every((v) => v >= 1)).toBe(true);
    }, FRAME_WAIT);
    const groups: Object3D[] = [];
    const geometries = new Set<string>();
    const sprites: Object3D[] = [];
    scene?.traverse((o) => {
      if (o.userData.agentId !== undefined) groups.push(o);
      if (o.type === "Sprite") sprites.push(o);
      if (o.type === "Mesh") geometries.add((o as Mesh).geometry.uuid);
    });
    expect(groups.map((g) => g.userData.agentId)).toEqual(["a1", "a2", "a3", "a4", "a5"]);
    expect(sprites).toHaveLength(6);
    // Only the agent with an attention record carries an emote, and it shows "!" (needs_you).
    // The emote is the sprite marked as decoration (`isHull`); the other sprite is the label.
    const emotesOf = (id: string): Sprite[] =>
      (groups.find((g) => g.userData.agentId === id)?.children ?? []).filter(
        (c): c is Sprite => c.type === "Sprite" && c.userData.isHull === true,
      );
    expect(emotesOf("a4")).toHaveLength(1);
    expect(emotesOf("a4")[0]?.visible).toBe(true);
    expect(emotesOf("a4")[0]?.material).toBe(emoteMaterial("!"));
    for (const id of ["a1", "a2", "a3", "a5"]) expect(emotesOf(id)).toHaveLength(0);
    // Placement, in the agent's local space (a4 is full size, so local is also world scale): the
    // emote's top edge stops below the label anchor and below the local fallback label's bottom
    // edge, and its centre sits above the top of the head. The numbers come from the scene and
    // LABEL_HEIGHT; marks.ts keeps the emote size and offset private, so only the relations are
    // pinned.
    const a4 = groups.find((g) => g.userData.agentId === "a4");
    const emote = emotesOf("a4")[0];
    const label = a4?.children.find((c) => c.type === "Sprite" && c.userData.isHull !== true);
    expect(a4?.scale.y).toBe(1);
    expect(emote?.parent).toBe(a4);
    expect(label).toBeDefined();
    const headTop = Math.max(
      ...(a4?.children ?? [])
        .filter((c): c is Mesh => c.type === "Mesh" && c.userData.isHull !== true)
        .map((m) => {
          m.geometry.computeBoundingBox();
          return m.position.y + (m.geometry.boundingBox?.max.y ?? 0);
        }),
    );
    const emoteTop = (emote?.position.y ?? 0) + (emote?.scale.y ?? 0) / 2;
    const labelBottom = (label?.position.y ?? 0) - (label?.scale.y ?? 0) / 2;
    expect(emoteTop).toBeLessThan(LABEL_HEIGHT);
    expect(emoteTop).toBeLessThanOrEqual(labelBottom);
    expect(emote?.position.y).toBeGreaterThan(headTop);
    // Five agents share one set of body geometries (plus the grid helper is not a Mesh), and the
    // attention rim hulls reuse them. The one extra is the pooled ground-ring geometry that a4's
    // needs_you ring adds (M4.05).
    expect(geometries.size).toBeLessThanOrEqual(10);
    expect(groups[4]?.scale.x).toBeCloseTo(0.6);
    if (CAPTURE) {
      await page
        .getByTestId("stage")
        .screenshot({ path: "../../../../../docs/tasks/M3.05/agents.png" });
    }
  }, 30_000);

  it("freezes the work-loop pose under reduced motion and animates it otherwise", async () => {
    const worker = (): AgentView[] => [
      agent({ id: "w1", displayName: "Ada", activity: "implementing" }, 0),
    ];
    const stage = async (reducedMotion: boolean) => {
      let state: RootState | undefined;
      const screen = await render(
        <div style={{ width: 200, height: 150 }}>
          <Canvas
            frameloop="never"
            camera={{ position: [0, 1.5, 3], fov: 40 }}
            onCreated={(s) => {
              state = s;
            }}
          >
            <AgentsLayer agents={worker()} reducedMotion={reducedMotion} />
          </Canvas>
        </div>,
      );
      await vi.waitFor(
        () => expect(state?.scene.children.some((o) => o.userData.agentId === "w1")).toBe(true),
        FRAME_WAIT,
      );
      return { state: state as RootState, screen };
    };
    /**
     * Drives `seconds` of 20 ms frames by hand (`frameloop="never"`: `advance` sets the clock and
     * draws), so a starved requestAnimationFrame cannot thin the samples. Records the arm swing
     * angles (every child group of the agent root: the two shoulders) after each frame.
     */
    const sampleArms = (state: RootState, seconds: number) => {
      const body = state.scene.children.find((o) => o.userData.agentId === "w1");
      expect(body).toBeDefined();
      const t0 = state.clock.elapsedTime;
      const f0 = state.gl.info.render.frame;
      const samples: number[][] = [];
      for (let i = 1; i <= Math.round(seconds / 0.02); i++) {
        state.advance(t0 + i * 0.02);
        samples.push(
          (body?.children ?? []).filter((c) => c.type === "Group").map((c) => c.rotation.x),
        );
      }
      return {
        samples,
        clockAdvance: state.clock.elapsedTime - t0,
        framesDrawn: state.gl.info.render.frame - f0,
      };
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
    const frozen = sampleArms(still.state, 0.8);
    await still.screen.unmount();
    // The clock ran and frames were drawn, the arms are posed, and nothing moved.
    expect(frozen.clockAdvance).toBeGreaterThan(0.5);
    expect(frozen.framesDrawn).toBe(frozen.samples.length);
    expect(frozen.samples[0]?.some((x) => Math.abs(x) > 0.5)).toBe(true);
    expect(spread(frozen.samples)).toBeLessThan(1e-9);

    const moving = await stage(false);
    const live = sampleArms(moving.state, 0.8);
    await moving.screen.unmount();
    expect(live.clockAdvance).toBeGreaterThan(0.5);
    expect(live.framesDrawn).toBe(live.samples.length);
    // The hammer arm swings through about 1.8 rad per loop; 0.8 s covers most of a 1.2 s loop.
    expect(spread(live.samples)).toBeGreaterThan(0.5);
  }, 30_000);
});
