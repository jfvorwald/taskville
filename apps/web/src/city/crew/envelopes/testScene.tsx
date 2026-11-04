import { Canvas, type RootState } from "@react-three/fiber";
import type { Object3D } from "three";
import { Vector3 } from "three";
import { expect, vi } from "vitest";
import { render } from "vitest-browser-react";
import { type Agent, initialState, type ProjectState } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../../overlays/host/index.ts";
import { createCameraRig } from "../../interaction/cameraRig.ts";
import { InteractionLayer } from "../../interaction/InteractionLayer.tsx";
import { createSelectionStore } from "../../interaction/selection.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { EnvelopeLayer } from "./EnvelopeLayer.tsx";
import { AT, PROJECT } from "./envelopeFixtures.ts";
import { createFeedFocus } from "./feedFocus.ts";

// A harness for the M5.04 browser tests: the envelope layer next to the real InteractionLayer in
// a real R3F scene over a store with an injectable clock. Not a test file itself.

export const FRAME_WAIT = { timeout: 10_000 };

const teammate = (id: string, displayName: string): Agent =>
  ({
    id,
    sourceId: "claude-code",
    sourceAgentId: id,
    displayName,
    kind: "teammate",
    registered: true,
    connection: "connected",
    firstSeenAt: AT,
    lastSeenAt: AT,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
  }) as Agent;

export async function mount() {
  const clock = { now: 0 };
  const store = createDataStore({ now: () => clock.now });
  const agents = [teammate("pip", "Pip"), teammate("bo", "Bo")];
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState({
    ...initialState(PROJECT),
    agents: Object.fromEntries(agents.map((a) => [a.id, a])),
  } as unknown as ProjectState);
  const anchors = createAnchorSource();
  anchors.setAnchor(agentAnchorId("pip"), [-1, 0, 0]);
  anchors.setAnchor(agentAnchorId("bo"), [1, 0, 0]);
  const selection = createSelectionStore();
  const feedFocus = createFeedFocus();
  let captured: RootState | undefined;
  const screen = await render(
    <div style={{ width: 480, height: 360 }}>
      <Canvas
        camera={{ position: [0, 3, 6], fov: 40 }}
        onCreated={(s) => {
          captured = s;
        }}
      >
        <InteractionLayer store={selection} rig={createCameraRig()} reducedMotion />
        <EnvelopeLayer
          store={store}
          anchors={anchors}
          selection={selection}
          feedFocus={feedFocus}
          reducedMotion
        />
      </Canvas>
    </div>,
  );
  await vi.waitFor(() => expect(captured).toBeDefined(), FRAME_WAIT);
  const root = (): RootState => {
    if (captured === undefined) throw new Error("scene not created");
    return captured;
  };
  const envelopes = (): Object3D[] => {
    const found: Object3D[] = [];
    root().scene.traverse((o) => {
      if (o.userData.envelopeId !== undefined) found.push(o);
    });
    return found;
  };
  const frames = async (n: number) => {
    const target = root().gl.info.render.frame + n;
    await vi.waitFor(
      () => expect(root().gl.info.render.frame).toBeGreaterThanOrEqual(target),
      FRAME_WAIT,
    );
  };
  /** Where `o` is on the canvas, in px from its top-left corner. */
  const onCanvas = (o: Object3D) => {
    const camera = root().camera;
    camera.updateMatrixWorld();
    const p = o.getWorldPosition(new Vector3()).project(camera);
    const rect = root().gl.domElement.getBoundingClientRect();
    return { x: ((p.x + 1) / 2) * rect.width, y: ((1 - p.y) / 2) * rect.height };
  };
  return {
    root,
    clock,
    store,
    selection,
    feedFocus,
    envelopes,
    frames,
    onCanvas,
    unmount: () => screen.unmount(),
  };
}
