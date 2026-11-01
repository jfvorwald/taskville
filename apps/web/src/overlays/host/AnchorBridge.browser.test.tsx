import { Canvas } from "@react-three/fiber";
import type { Camera } from "three";
import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { AnchorBridge } from "./AnchorBridge.tsx";
import { createAnchorSource } from "./anchors.ts";

const SIZE = { width: 400, height: 300 };

/** What a correct bridge must produce: three.js's own projection, mapped to CSS pixels (+y down). */
function expectedPixels(camera: Camera, world: [number, number, number]) {
  camera.updateMatrixWorld();
  const ndc = new Vector3(...world).project(camera);
  return {
    x: (ndc.x * 0.5 + 0.5) * SIZE.width,
    y: (1 - (ndc.y * 0.5 + 0.5)) * SIZE.height,
  };
}

describe("AnchorBridge", () => {
  it("publishes a projection that matches three.js for the real camera", async () => {
    const source = createAnchorSource();
    let camera: Camera | undefined;
    source.setAnchor("centre", [0, 0, 0]);
    source.setAnchor("off-axis", [2, 1.5, -1]);

    await render(
      <div style={{ width: SIZE.width, height: SIZE.height }}>
        <Canvas
          camera={{ position: [3, 4, 5], fov: 50, near: 0.1, far: 100 }}
          onCreated={(state) => {
            state.camera.lookAt(0, 0, 0);
            camera = state.camera;
          }}
        >
          <AnchorBridge source={source} />
        </Canvas>
      </div>,
    );

    await expect.poll(() => source.project("off-axis"), { timeout: 5000 }).not.toBeNull();
    expect(camera).toBeDefined();
    const cam = camera as Camera;

    expect(source.getViewport()).toEqual(SIZE);

    // The look-at target lands in the middle of the canvas.
    const centre = source.project("centre");
    expect(centre?.visible).toBe(true);
    expect(centre?.x).toBeCloseTo(SIZE.width / 2, 1);
    expect(centre?.y).toBeCloseTo(SIZE.height / 2, 1);

    // An off-axis point catches a transposed (row-major) matrix or a flipped y.
    const want = expectedPixels(cam, [2, 1.5, -1]);
    const got = source.project("off-axis");
    expect(got?.visible).toBe(true);
    expect(got?.x).toBeCloseTo(want.x, 1);
    expect(got?.y).toBeCloseTo(want.y, 1);
    expect(Math.abs((got?.x ?? 0) - SIZE.width / 2)).toBeGreaterThan(10);
    expect(Math.abs((got?.y ?? 0) - SIZE.height / 2)).toBeGreaterThan(10);
  });
});
