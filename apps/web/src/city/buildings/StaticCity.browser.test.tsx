import { Canvas, type RootState } from "@react-three/fiber";
import { type Camera, Matrix4, type Object3D, Quaternion, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CityScene } from "./CityScene.tsx";

// W1.05 (#549): the static city (ground, streets, plaza, buildings, windows, scenery, break props)
// on the demo layout with no agents draws in at most 25 calls (69 drawables today), and its objects
// do not recompute their matrices every frame. Per-building hover and fade (InteractionLayer) and
// theme switching must survive; their own tests cover that.

const MAX_CALLS = 25;

let state: RootState | undefined;
afterEach(() => {
  state = undefined;
});

function Scene() {
  return (
    <div style={{ width: 320, height: 240 }}>
      {/* frameloop "never": nothing else renders, so the one render below is the only one counted. */}
      <Canvas
        frameloop="never"
        onCreated={(s) => {
          state = s;
        }}
      >
        <CityScene />
      </Canvas>
    </div>
  );
}

async function mountCity(): Promise<RootState> {
  await render(<Scene />);
  await vi.waitFor(() => expect(state).toBeDefined());
  const s = state as RootState;
  // Let React commit the whole city (effects, instance matrices) before drawing.
  await vi.waitFor(() => expect(s.scene.getObjectByName("city")).toBeDefined());
  await new Promise((r) => setTimeout(r, 200));
  return s;
}

describe("static city draw cost", () => {
  it(`draws the demo city with no agents in at most ${MAX_CALLS} calls`, async () => {
    const s = await mountCity();
    // renderer.info resets at the start of each render while autoReset is on, so after exactly one
    // render the counters hold that frame alone. The scene holds only the city (no agents).
    s.gl.info.autoReset = true;
    s.gl.render(s.scene, s.camera);
    expect(s.gl.info.render.calls).toBeGreaterThan(0); // something was drawn
    expect(s.gl.info.render.calls).toBeLessThanOrEqual(MAX_CALLS);
  });

  it("keeps matrixAutoUpdate off on every static object, with matrices already composed", async () => {
    const s = await mountCity();
    const city = s.scene.getObjectByName("city");
    if (!city) throw new Error("no city group");
    const auto: string[] = [];
    const stale: string[] = [];
    const expected = new Matrix4();
    city.traverse((o: Object3D) => {
      // The camera is moved by the rig, and lights are not part of the city drawables.
      if ((o as Camera).isCamera || (o as { isLight?: boolean }).isLight) return;
      const label = `${o.type}:${o.name || o.parent?.name || "?"}`;
      if (o.matrixAutoUpdate) auto.push(label);
      // With auto-update off nothing recomposes the matrix, so it must already match the transform.
      expected.compose(
        new Vector3().copy(o.position),
        new Quaternion().copy(o.quaternion),
        new Vector3().copy(o.scale),
      );
      if (!o.matrix.equals(expected)) stale.push(label);
    });
    const summary = (list: string[]) =>
      `${list.length}: ${[...new Set(list)].slice(0, 6).join(", ")}`;
    expect(summary(auto), "objects with matrixAutoUpdate on").toBe("0: ");
    expect(summary(stale), "objects whose matrix is not composed").toBe("0: ");
  });
});
