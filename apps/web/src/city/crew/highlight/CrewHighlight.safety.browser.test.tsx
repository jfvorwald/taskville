import { Canvas, useThree } from "@react-three/fiber";
import type { ReactNode } from "react";
import {
  BoxGeometry,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type OrthographicCamera,
  Scene,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../../test/data/fake-engine.ts";
import { createDataStore } from "../../../data/store.ts";
import { AgentBlock } from "../../agents/AgentBlock.tsx";
import type { AgentView } from "../../agents/types.ts";
import { selectionStore } from "../../interaction/selection.ts";
import { agent, FRAME_WAIT, stateOf, sub } from "../subagents/testScene.tsx";
import { CrewHighlight } from "./CrewHighlight.tsx";
import { createHighlightStore, type HighlightStore } from "./highlightStore.ts";

// M5.22 red (#337): render wrapper safety, from the M5.08 confirming review of PR #329.
//
// The scene is built by hand: L (lead) at (2,0,2); c1 (L's subagent) at (4,0,-2); o (an unrelated
// agent, outside the family) at (-3,0,1). Each is a Group with userData.agentId and one Mesh that
// shares the `pooled` material. Most tests render with frameloop "never" and call `gl.render`
// themselves, so the draw is the only thing that runs CrewHighlight's work and each assertion is
// about exactly the draws the test made.
//
// Pinned behavior (the interface is unchanged: <CrewHighlight store inputs />):
//   1. A render of any scene other than the main scene (a RenderTexture, Hud or portal scene) must
//      neither sync nor forget the main scene's lift or dim set.
//   2. On unmount, gl.render is restored only if it is still this instance's wrapper. Otherwise
//      the instance marks itself dead: gl.render is left alone (whoever installed after it still
//      works), and this instance's wrapper passes through to the previous render untouched.
//   3. Unmount takes an active lift off the bot.
//   4. The id-to-group lookup must not go stale while the clock is stopped (elapsedTime frozen).
//   5. An AgentBlock parent (the real component, registered after CrewHighlight) is still lifted
//      and its outsiders still faded as drawn (pin; passes today).

const FRAME = { timeout: 5000 };
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Harness {
  scene: Scene;
  camera: OrthographicCamera;
  gl: { render: (scene: Object3D, camera: OrthographicCamera) => void };
  groups: Record<string, Group>;
  pooled: MeshStandardMaterial;
  /** Every call that reached the original renderer, in order. */
  drawn: Object3D[];
  store: ReturnType<typeof makeStore>;
  /** Draws the main scene. */
  drawMain: () => void;
  screen: Awaited<ReturnType<typeof render>>;
  rerender: (children: ReactNode) => Promise<void>;
}

function makeStore() {
  const store = createDataStore({ now: () => 0 });
  store.getState().reset(PROJECT);
  store
    .getState()
    .applySnapshotState(
      stateOf([agent("L", { kind: "lead" }), sub("c1", "L"), agent("o", { kind: "session" })]),
    );
  return store;
}

async function mount(
  children: (store: ReturnType<typeof makeStore>) => ReactNode,
  opts: { frameloop?: "never" | "always" } = {},
): Promise<Harness> {
  const store = makeStore();
  const h = {
    groups: {},
    pooled: new MeshStandardMaterial({ color: 0x3366cc }),
    drawn: [],
    store,
  } as unknown as Harness;
  const at: Record<string, [number, number, number]> = {
    L: [2, 0, 2],
    c1: [4, 0, -2],
    o: [-3, 0, 1],
  };
  const view = () => (
    <div style={{ width: 300, height: 200 }}>
      <Canvas
        orthographic
        frameloop={opts.frameloop ?? "never"}
        camera={{ position: [10, 8, 10], zoom: 40 }}
        onCreated={(state) => {
          state.camera.lookAt(0, 0, 0);
          h.camera = state.camera as OrthographicCamera;
          h.scene = state.scene;
          h.gl = state.gl as unknown as Harness["gl"];
          const base = state.gl.render.bind(state.gl);
          state.gl.render = ((scene: Object3D, camera: never) => {
            h.drawn.push(scene);
            base(scene as never, camera);
          }) as never;
          for (const [id, p] of Object.entries(at)) {
            const g = new Group();
            g.userData.agentId = id;
            g.position.set(...p);
            g.add(new Mesh(new BoxGeometry(0.5, 0.5, 0.5), h.pooled));
            state.scene.add(g);
            h.groups[id] = g;
          }
        }}
      >
        {children(store)}
      </Canvas>
    </div>
  );
  h.screen = await render(view());
  await vi.waitFor(() => expect(h.groups.o).toBeDefined(), FRAME);
  h.drawMain = () => h.gl.render(h.scene, h.camera);
  h.rerender = async (next) => {
    await h.screen.rerender(
      <div style={{ width: 300, height: 200 }}>
        <Canvas
          orthographic
          frameloop={opts.frameloop ?? "never"}
          camera={{ position: [10, 8, 10], zoom: 40 }}
        >
          {next}
        </Canvas>
      </div>,
    );
  };
  return h;
}

const isFaded = (g: Group | undefined) => {
  const m = (g?.children[0] as Mesh | undefined)?.material as Material | undefined;
  return m !== undefined && m.opacity < 1;
};

afterEach(() => selectionStore.select(null));

describe("gl.render wrapper only syncs the main scene", () => {
  it("a render of another scene does not forget the main scene's dim set", async () => {
    const inputs = createHighlightStore();
    const h = await mount((store) => <CrewHighlight store={store} inputs={inputs} />);
    inputs.open("L");
    // Dim the outsider: draw the main scene until the highlight has caught up with the tab.
    await vi.waitFor(() => {
      h.drawMain();
      expect(isFaded(h.groups.o)).toBe(true);
    }, FRAME);
    // The tab closes: o must be un-dimmed by the next MAIN draw. A draw of a texture scene that
    // contains no agent groups comes first, and must leave the dim set alone.
    inputs.open(null);
    await wait(150);
    const other = new Scene();
    other.add(new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial()));
    h.gl.render(other, h.camera);
    h.drawMain();
    expect(isFaded(h.groups.o)).toBe(false);
    expect(h.groups.o?.children[0] && (h.groups.o.children[0] as Mesh).material).toBe(h.pooled);
  });

  it("a render of another scene does not forget the main scene's lift", async () => {
    const inputs = createHighlightStore();
    const h = await mount((store) => <CrewHighlight store={store} inputs={inputs} />);
    inputs.open("L");
    inputs.hover("c1");
    // The hop starts at the first main draw that sees the hover.
    await vi.waitFor(() => {
      h.drawMain();
      expect(h.groups.c1?.position.y).toBeGreaterThan(0.01);
    }, FRAME);
    h.gl.render(new Scene(), h.camera);
    // The hop is 450 ms. After it, a main draw must leave the bot at rest, not stuck up.
    await wait(700);
    h.drawMain();
    expect(h.groups.c1?.position.y).toBeCloseTo(0, 6);
  });
});

describe("unmount restores gl.render only if it is still the current wrapper", () => {
  it("unmounting the first of two instances leaves the second one's wrapper installed", async () => {
    const a = createHighlightStore();
    const b = createHighlightStore();
    const both = (store: ReturnType<typeof makeStore>, showA: boolean) => (
      <>
        {showA && <CrewHighlight key="a" store={store} inputs={a} />}
        <CrewHighlight key="b" store={store} inputs={b} />
      </>
    );
    const h = await mount((store) => both(store, true));
    // Unmount A only (B stays mounted; the Canvas and its renderer are the same).
    await h.rerender(both(h.store, false));
    b.open("L");
    // B is alive: the outsider is dimmed by a main draw, and the original renderer ran once.
    await vi.waitFor(() => {
      h.drawn.length = 0;
      h.drawMain();
      expect(isFaded(h.groups.o)).toBe(true);
    }, FRAME);
    expect(h.drawn).toEqual([h.scene]);
  });

  it("a foreign wrapper installed after it survives its unmount, and the dead wrapper passes through", async () => {
    const inputs = createHighlightStore();
    const withHighlight = (store: ReturnType<typeof makeStore>, show: boolean) =>
      show ? <CrewHighlight store={store} inputs={inputs} /> : null;
    const h = await mount((store) => withHighlight(store, true));
    inputs.open("L");
    await vi.waitFor(() => {
      h.drawMain();
      expect(isFaded(h.groups.o)).toBe(true);
    }, FRAME);
    // Someone else wraps render after CrewHighlight did.
    const inner = h.gl.render;
    let foreignCalls = 0;
    const foreign = (scene: Object3D, camera: OrthographicCamera) => {
      foreignCalls++;
      inner.call(h.gl, scene, camera);
    };
    h.gl.render = foreign;
    await h.rerender(withHighlight(h.store, false));
    // The foreign wrapper is still the current render, not overwritten by the unmount.
    expect(h.gl.render).toBe(foreign);
    // The tab is still open in `inputs`, but the unmounted instance is dead: it passes through and
    // does not dim again.
    h.drawn.length = 0;
    h.drawMain();
    expect(foreignCalls).toBe(1);
    expect(h.drawn).toEqual([h.scene]);
    expect(isFaded(h.groups.o)).toBe(false);
  });
});

describe("unmount cleanup", () => {
  it("takes an active lift off the bot", async () => {
    const inputs = createHighlightStore();
    const withHighlight = (store: ReturnType<typeof makeStore>, show: boolean) =>
      show ? <CrewHighlight store={store} inputs={inputs} /> : null;
    const h = await mount((store) => withHighlight(store, true));
    inputs.open("L");
    inputs.hover("c1");
    await vi.waitFor(() => {
      h.drawMain();
      expect(h.groups.c1?.position.y).toBeGreaterThan(0.01);
    }, FRAME);
    // Unmount inside the hop (450 ms), with no draw in between.
    await h.rerender(withHighlight(h.store, false));
    expect(h.groups.c1?.position.y).toBeCloseTo(0, 6);
  });
});

describe("id-to-group lookup with a stopped clock", () => {
  it("a ring follows a bot whose group was replaced while the clock is stopped", async () => {
    const inputs = createHighlightStore();
    let stop: (() => void) | undefined;
    const h = await mount(
      (store) => (
        <>
          <Stopper onReady={(fn) => (stop = fn)} />
          <CrewHighlight store={store} inputs={inputs} />
        </>
      ),
      { frameloop: "always" },
    );
    inputs.open("L");
    const ringAt = () =>
      (h.scene.getObjectByName("crew-highlight")?.children ?? []).filter(
        (o) => (o as Mesh).isMesh && (o as Mesh).geometry.type === "RingGeometry",
      );
    await vi.waitFor(() => expect(ringAt().length).toBe(2), FRAME);
    await wait(150);
    // Freeze time (elapsedTime stops moving; frames keep coming), then replace c1's group.
    stop?.();
    await wait(150);
    h.groups.c1?.removeFromParent();
    const fresh = new Group();
    fresh.userData.agentId = "c1";
    fresh.position.set(6, 0, 6);
    h.scene.add(fresh);
    await vi.waitFor(
      () =>
        expect(
          ringAt().some((r) => r.visible && Math.hypot(r.position.x - 6, r.position.z - 6) < 0.01),
        ).toBe(true),
      FRAME,
    );
  });
});

function Stopper({ onReady }: { onReady: (stop: () => void) => void }) {
  const clock = useThree((s) => s.clock);
  onReady(() => clock.stop());
  return null;
}

describe("AgentBlock parent", () => {
  const view = (id: string, kind: AgentView["kind"]): AgentView => ({
    id,
    kind,
    activity: "idle",
    placement: { x: id === "L" ? 2 : -3, y: 0, z: id === "L" ? 2 : 1, heading: 0 },
  });

  it("(pin, passes today) the hovered AgentBlock parent is lifted and an AgentBlock outsider is faded as drawn", {
    timeout: 120_000,
  }, async () => {
    const store = makeStore();
    const inputs: HighlightStore = createHighlightStore();
    const seen = { y: [] as number[], dim: [] as boolean[] };
    let scene: Object3D | undefined;
    const find = (root: Object3D, id: string) => {
      let found: Object3D | undefined;
      root.traverse((o) => {
        if (o.userData?.agentId === id) found = o;
      });
      return found;
    };
    await render(
      <div style={{ width: 300, height: 200 }}>
        <Canvas
          camera={{ position: [0, 6, 10], fov: 40 }}
          onCreated={(s) => {
            scene = s.scene;
            const draw = s.gl.render.bind(s.gl);
            s.gl.render = ((sc: Object3D, camera: never) => {
              const parent = find(sc, "L");
              const outsider = find(sc, "o");
              if (parent !== undefined) seen.y.push(parent.position.y);
              if (outsider !== undefined) {
                const mats: Material[] = [];
                outsider.traverse((o) => {
                  const m = (o as Mesh).material;
                  if ((o as Mesh).isMesh) mats.push(...(Array.isArray(m) ? m : [m as Material]));
                });
                seen.dim.push(mats.length > 0 && mats.every((m) => m.opacity < 1));
              }
              draw(sc as never, camera);
            }) as never;
          }}
        >
          {/* CrewHighlight first, so the AgentBlocks' frame callbacks run after it. */}
          <CrewHighlight store={store} inputs={inputs} />
          <AgentBlock agent={view("L", "lead")} reducedMotion localLabel={false} />
          <AgentBlock agent={view("o", "session")} reducedMotion localLabel={false} />
        </Canvas>
      </div>,
    );
    await vi.waitFor(() => expect(seen.y.length).toBeGreaterThan(5), FRAME_WAIT);
    expect(scene).toBeDefined();
    const rest = Math.min(...seen.y);
    inputs.open("L");
    let lifted = rest;
    for (let attempt = 0; attempt < 10 && !(lifted > rest + 0.05); attempt++) {
      inputs.hover(null);
      const mark = seen.y.length;
      await vi.waitFor(() => expect(seen.y.length).toBeGreaterThanOrEqual(mark + 3), {
        timeout: 30_000,
      });
      inputs.hover("L");
      const from = seen.y.length;
      await vi.waitFor(() => expect(seen.y.length).toBeGreaterThanOrEqual(from + 40), {
        timeout: 30_000,
      });
      lifted = Math.max(...seen.y.slice(from));
    }
    expect(lifted).toBeGreaterThan(rest + 0.05);
    const mark = seen.dim.length;
    await vi.waitFor(() => expect(seen.dim.length).toBeGreaterThanOrEqual(mark + 25), {
      timeout: 30_000,
    });
    expect(seen.dim.slice(-20).every(Boolean)).toBe(true);
  });
});
