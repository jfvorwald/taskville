import { Canvas, type RootState } from "@react-three/fiber";
import { type Mesh, type Object3D, Vector3 } from "three";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { AT, PROJECT, teamScenario } from "../../../../test/city/crew/teams/integration.fixture.ts";
import { createDataStore } from "../../../data/store.ts";
import { sharedGeometries } from "../../agents/resources.ts";
import { CityAgents } from "../../movement/CityAgents.tsx";

function world(object: Object3D) {
  object.updateWorldMatrix(true, false);
  return object.getWorldPosition(new Vector3());
}

it("keeps an implementing lead's body pose and hat offset stationary under CityAgents reduced motion", async () => {
  const scenario = teamScenario();
  const store = createDataStore({ now: () => Date.parse(AT) });
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(scenario.state);
  const work = scenario.leadWork();
  store.getState().applyEvent({ ...work, payload: { activity: "implementing" } });
  expect(store.getState().state?.activity.lead?.activity).toBe("implementing");
  let root: RootState | undefined;
  const screen = await render(
    <div style={{ width: 240, height: 180 }}>
      <Canvas
        frameloop="never"
        onCreated={(value) => {
          root = value;
        }}
      >
        <CityAgents store={store} reducedMotion={true} />
      </Canvas>
    </div>,
  );
  try {
    const all = () => {
      const objects: Object3D[] = [];
      root?.scene.traverse((object) => objects.push(object));
      return objects;
    };
    const lead = () =>
      all().find(
        (object) =>
          object.userData.agentId === "lead" &&
          object.children.some((child) => (child as Mesh).geometry === sharedGeometries().torso),
      );
    const hat = () => all().find((object) => object.userData.hardHat === true);
    await vi.waitFor(
      () => {
        expect(lead()).toBeDefined();
        expect(hat()).toBeDefined();
      },
      { timeout: 10_000 },
    );
    const body = lead();
    const hardHat = hat();
    if (!root || !body || !hardHat) throw new Error("Lead body and hard hat must mount");
    const head = body.children.find(
      (child) => (child as Mesh).geometry === sharedGeometries().head,
    );
    expect(head).toBeDefined();
    if (!head) throw new Error("Missing pooled lead head");
    const samples: { pose: number[]; offset: number[] }[] = [];
    const start = root.clock.elapsedTime;
    const frames = root.gl.info.render.frame;
    for (let i = 1; i <= 60; i++) {
      root.advance(start + i * 0.02);
      samples.push({
        pose: [
          ...world(body).toArray(),
          ...(body.rotation.toArray().slice(0, 3) as number[]),
          ...body.children
            .filter((child) => child.type === "Group")
            .map((child) => child.rotation.x),
        ],
        offset: world(hardHat).sub(world(head)).toArray(),
      });
    }
    expect(root.clock.elapsedTime - start).toBeCloseTo(1.2);
    expect(root.gl.info.render.frame - frames).toBe(60);
    expect(
      samples[0]?.pose.some((value) => value < -0.5),
      "implementing work pose is present",
    ).toBe(true);
    for (const sample of samples) {
      expect(sample.pose, "body and arms stay stationary as the frame clock advances").toEqual(
        samples[0]?.pose,
      );
      expect(sample.offset[1], "hard hat remains above the pooled head").toBeGreaterThan(0);
    }
    for (const sample of samples) {
      for (let axis = 0; axis < 3; axis++) {
        expect(sample.offset[axis], "hard hat must share the body's frozen work pose").toBeCloseTo(
          samples[0]?.offset[axis] ?? 0,
          9,
        );
      }
    }
  } finally {
    await screen.unmount();
    store.getState().reset(PROJECT);
  }
}, 30_000);
