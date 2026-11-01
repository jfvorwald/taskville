import { Canvas, type RootState } from "@react-three/fiber";
import type { Material, Mesh, Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { eventBuilder, PROJECT, registered } from "../../../test/data/fake-engine.ts";
import { initialState, type ProjectState, reduce } from "../../data/domain.ts";
import { createDataStore } from "../../data/store.ts";
import { ringMaterial } from "../attention/resources.ts";
import { CityAgents } from "./CityAgents.tsx";

// One clock (roborev 5804): the city's attention marks run on the clock of the DataStore they are
// given, not on `Date.now`. The store here is built with an injected `now` that is far from the
// real wall clock, and the ring's pulse step is read from the pooled material it ends up with.
//
// The request opens at SINCE. A store clock 500 ms later is half a cycle into the 1 Hz pulse: the
// peak (step 12). A clock 10 min + 500 ms later is a quarter cycle into the slowed 0.5 Hz pulse:
// the mid step (6), where the 1 Hz rate would have said the peak. The real `Date.now` is the same
// for both renders, so a city that read it could not satisfy both.

const FRAME_WAIT = { timeout: 10_000 };
const SINCE = "2026-10-30T10:05:00.000Z";
const SINCE_MS = Date.parse(SINCE);
const MIN = 60_000;

function stateWithOpenRequest(): ProjectState {
  const base = registered(eventBuilder(), "a1").reduce(reduce, initialState(PROJECT));
  return {
    ...base,
    requests: {
      r1: {
        id: "r1",
        agentId: "a1",
        kind: "permission",
        answerable: false,
        openedAt: SINCE,
        state: "open",
        late: false,
        mergedRequestIds: [],
      },
    },
  } as unknown as ProjectState;
}

/** Renders the city over a store whose clock reads `now`, and returns the ring's pooled step. */
async function ringStepAt(now: number): Promise<number | undefined> {
  const store = createDataStore({ now: () => now });
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(stateWithOpenRequest());
  expect(store.getState().attention[0]?.level).toBe("needs_you");

  let root: RootState | undefined;
  const screen = await render(
    <div style={{ width: 240, height: 180 }}>
      <Canvas
        camera={{ position: [0, 3, 6], fov: 40 }}
        onCreated={(s) => {
          root = s;
        }}
      >
        <CityAgents store={store} reducedMotion={false} />
      </Canvas>
    </div>,
  );
  const ringOf = (): Mesh | undefined => {
    const g: Object3D | undefined = root?.scene.children.find((o) => o.userData.agentId === "a1");
    return g?.children.find(
      (c): c is Mesh => c.userData.isHull === true && (c as Mesh).geometry?.type === "RingGeometry",
    );
  };
  await vi.waitFor(() => expect(ringOf()).toBeDefined(), FRAME_WAIT);
  // A few more frames, so the per-frame update has run on the final clock.
  const target = (root?.gl.info.render.frame ?? 0) + 4;
  await vi.waitFor(
    () => expect(root?.gl.info.render.frame).toBeGreaterThanOrEqual(target),
    FRAME_WAIT,
  );
  const material = ringOf()?.material as Material | undefined;
  await screen.unmount();
  for (let step = 0; step <= 12; step++) {
    if (ringMaterial("red", step) === material) return step;
  }
  return undefined;
}

describe("CityAgents attention clock", () => {
  it("pulses at 1 Hz when the store clock is 500 ms after the request opened", async () => {
    expect(await ringStepAt(SINCE_MS + 500)).toBe(12);
  }, 30_000);

  it("pulses at the slowed rate when the store clock is 10 min and 500 ms after", async () => {
    expect(await ringStepAt(SINCE_MS + 10 * MIN + 500)).toBe(6);
  }, 30_000);
});
