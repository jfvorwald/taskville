import { Canvas, type RootState } from "@react-three/fiber";
import { type Object3D, Vector3 } from "three";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createDataStore } from "../../../data/store.ts";
import { createAnchorSource } from "../../../overlays/host/index.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { CityAgents } from "../../movement/CityAgents.tsx";
import { SubagentCrew } from "./SubagentCrew.tsx";
import { LEAD, stateOf, sub, T, WORKING_MS } from "./testScene.tsx";

it("anchors a needs-you crew bubble to its drawn bot through work and return, then removes it", async () => {
  const clock = { now: 0 };
  const store = createDataStore({ now: () => clock.now });
  const initial = stateOf([LEAD, sub("kid", "lead")], ["kid"]);
  store.getState().reset(initial.projectId);
  store.getState().applySnapshotState(initial);
  const anchors = createAnchorSource();
  let root: RootState | undefined;
  const view = await render(
    <div style={{ width: 320, height: 240 }}>
      <Canvas
        onCreated={(state) => {
          root = state;
        }}
      >
        <CityAgents store={store} anchors={anchors} reducedMotion={true} />
        <SubagentCrew store={store} anchors={anchors} reducedMotion={true} />
      </Canvas>
    </div>,
  );
  const bot = () => {
    let found: Object3D | undefined;
    root?.scene.traverse((object) => {
      if (object.userData.agentId === "kid") found = object;
    });
    if (!found) throw new Error("Crew bot absent");
    return found;
  };
  const aligned = () => {
    const point = anchors.getAnchor(agentAnchorId("kid"));
    expect(point).toBeDefined();
    const position = bot().getWorldPosition(new Vector3());
    expect(point?.[0]).toBeCloseTo(position.x, 5);
    expect(point?.[2]).toBeCloseTo(position.z, 5);
  };
  const frames = async (count: number) => {
    const target = (root?.gl.info.render.frame ?? 0) + count;
    await vi.waitFor(() => expect(root?.gl.info.render.frame).toBeGreaterThanOrEqual(target));
  };
  try {
    await vi.waitFor(() => expect(root).toBeDefined());
    await frames(3);
    clock.now = WORKING_MS;
    await frames(5);
    await vi.waitFor(aligned);
    await frames(5);
    aligned();
    store.getState().applySnapshotState(stateOf([LEAD, sub("kid", "lead", { finishedAt: T })]));
    await frames(5);
    await vi.waitFor(aligned);
    clock.now += 10_000;
    await frames(5);
    await vi.waitFor(() => expect(anchors.getAnchor(agentAnchorId("kid"))).toBeUndefined());
  } finally {
    await view.unmount();
  }
});
