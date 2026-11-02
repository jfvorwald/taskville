import { Canvas } from "@react-three/fiber";
import type { Material, Mesh, Object3D, OrthographicCamera } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../../test/data/fake-engine.ts";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../../overlays/host/index.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { SubagentCrew } from "../subagents/SubagentCrew.tsx";
import { agent, FRAME_WAIT, stateOf, sub, WORKING_MS } from "../subagents/testScene.tsx";
import { CrewHighlight } from "./CrewHighlight.tsx";
import { createHighlightStore } from "./highlightStore.ts";

// M5.08 red round 3, blocker B1 (confirming review of PR #329 at 74edeb5).
// R3F runs equal-priority useFrame callbacks in registration order. SubagentCrew rewrites
// `bot.root.position.set(x, hop, z)` and re-assigns the bot's body and trim materials every
// frame, so when it registers AFTER CrewHighlight it erases the hover lift and the dim fade.
//
// Pinned (observable, as drawn): at the moment `gl.render(scene, camera)` is called, which is
// after every frame callback, the hovered family bot is lifted above its resting height and every
// mesh of a bot outside the family has a material with opacity < 1. This must hold whichever
// order the two layers registered in, including after SubagentCrew remounts (history mode swaps
// its `key`, so it re-registers after CrewHighlight). Implementation freedom: run CrewHighlight's
// frame work late (a larger useFrame priority, or after the render-affecting systems), or have the
// bot systems take the lift and the dim as inputs.
// NOT covered: an AgentBlock parent (no cheap harness exists); the implementer should apply the
// same ordering fix to it.

interface Seen {
  y: Record<string, number[]>;
  dim: Record<string, boolean[]>;
}

const IDS = ["c1", "d1"];

async function mount(order: "highlight-first" | "crew-first") {
  const clock = { now: 0 };
  const store = createDataStore({ now: () => clock.now });
  store.getState().reset(PROJECT);
  store
    .getState()
    .applySnapshotState(
      stateOf([
        agent("lead", { kind: "lead" }),
        sub("c1", "lead"),
        agent("lead2", { kind: "lead" }),
        sub("d1", "lead2"),
      ]),
    );
  clock.now = WORKING_MS;
  const anchors = createAnchorSource();
  anchors.setAnchor(agentAnchorId("lead"), [2, 0, 3]);
  anchors.setAnchor(agentAnchorId("lead2"), [-4, 0, -3]);
  const inputs = createHighlightStore();
  const seen: Seen = { y: { c1: [], d1: [] }, dim: { c1: [], d1: [] } };
  let root: { scene: Object3D; camera: OrthographicCamera } | undefined;
  const bots = (scene: Object3D) => {
    const found: Record<string, Object3D> = {};
    scene.traverse((o) => {
      const id = o.userData?.agentId;
      if (IDS.includes(id)) found[id] = o;
    });
    return found;
  };
  const view = (crewKey: string) => {
    const crew = (
      <SubagentCrew key={crewKey} store={store} anchors={anchors} reducedMotion={false} />
    );
    const highlight = <CrewHighlight key="highlight" store={store} inputs={inputs} />;
    return (
      <div style={{ width: 300, height: 200 }}>
        <Canvas
          camera={{ position: [0, 6, 10], fov: 40 }}
          onCreated={(s) => {
            root = { scene: s.scene, camera: s.camera as OrthographicCamera };
            const draw = s.gl.render.bind(s.gl);
            s.gl.render = (scene: Object3D, camera: never) => {
              const b = bots(scene);
              for (const id of IDS) {
                const bot = b[id];
                if (bot === undefined) continue;
                seen.y[id]?.push(bot.position.y);
                const meshes: Mesh[] = [];
                bot.traverse((o) => {
                  if ((o as Mesh).isMesh) meshes.push(o as Mesh);
                });
                const mats = meshes.flatMap((m) =>
                  Array.isArray(m.material) ? m.material : [m.material as Material],
                );
                seen.dim[id]?.push(mats.length > 0 && mats.every((m) => m.opacity < 1));
              }
              draw(scene as never, camera);
            };
          }}
        >
          {order === "highlight-first" ? (
            <>
              {highlight}
              {crew}
            </>
          ) : (
            <>
              {crew}
              {highlight}
            </>
          )}
        </Canvas>
      </div>
    );
  };
  const screen = await render(view("a"));
  await vi.waitFor(() => expect(root).toBeDefined(), FRAME_WAIT);
  await vi.waitFor(() => expect(seen.y.c1?.length).toBeGreaterThan(5), FRAME_WAIT);
  return {
    seen,
    inputs,
    remountCrew: () => screen.rerender(view("b")),
    clear: () => {
      for (const id of IDS) {
        (seen.y[id] as number[]).length = 0;
        (seen.dim[id] as number[] | boolean[]).length = 0;
      }
    },
    root: () => root,
  };
}

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Waits until `n` more frames have been drawn (counted at gl.render), however slow the machine. */
async function frames(w: Awaited<ReturnType<typeof mount>>, n: number) {
  const target = (w.seen.dim.d1 as boolean[]).length + n;
  await vi.waitFor(
    () => expect((w.seen.dim.d1 as boolean[]).length).toBeGreaterThanOrEqual(target),
    {
      timeout: 30_000,
    },
  );
}

async function expectHighlighted(w: Awaited<ReturnType<typeof mount>>) {
  // Resting height of c1, from before the highlight.
  const rest = Math.min(...(w.seen.y.c1 as number[]));
  w.clear();
  w.inputs.open("lead");
  // The hop is one 450 ms bounce per arrival, so a starved machine could draw no frame during it.
  // Hover again (after a few drawn frames) until frames were drawn during a hop, bounded by count.
  let lifted = rest;
  for (let attempt = 0; attempt < 10 && !(lifted > rest + 0.05); attempt++) {
    w.inputs.hover(null);
    await frames(w, 3);
    w.inputs.hover("c1");
    await frames(w, 40);
    lifted = Math.max(...(w.seen.y.c1 as number[]));
  }
  expect.soft(lifted).toBeGreaterThan(rest + 0.05);
  // Settled frames: the last 20 drawn frames show the outsider faded every time, not only on
  // frames where the highlight happened to run last.
  await frames(w, 25);
  const dim = w.seen.dim.d1 as boolean[];
  const settled = dim.slice(-20);
  expect(settled).toHaveLength(20);
  expect.soft(settled.every(Boolean)).toBe(true);
  // A family member is never faded.
  expect((w.seen.dim.c1 as boolean[]).some(Boolean)).toBe(false);
}

// The frame waits above allow up to 30 s each on a starved machine; the enclosing test timeout must
// cover them, or the browser default (15 s) cuts the test off first (roborev 6645).
const SLOW_TEST_MS = 120_000;

describe("highlight survives frame-callback order (B1)", () => {
  it("when SubagentCrew registers after CrewHighlight", { timeout: SLOW_TEST_MS }, async () => {
    await expectHighlighted(await mount("highlight-first"));
  });

  it("when SubagentCrew remounts after CrewHighlight (history mode key change)", {
    timeout: SLOW_TEST_MS,
  }, async () => {
    const w = await mount("crew-first");
    await w.remountCrew();
    await vi.waitFor(() => expect(w.seen.y.c1?.length).toBeGreaterThan(5), FRAME_WAIT);
    await expectHighlighted(w);
  });
});
