import { Canvas } from "@react-three/fiber";
import type { OrthographicCamera } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { CameraDriver } from "./CameraDriver.tsx";
import { createCameraRig } from "./cameraRig.ts";

function Stage({
  rig,
  driver,
  onCamera,
}: {
  rig: ReturnType<typeof createCameraRig>;
  driver: boolean;
  onCamera: (camera: OrthographicCamera) => void;
}) {
  return (
    <div style={{ width: 300, height: 200 }}>
      <Canvas
        orthographic
        camera={{ position: [10, 8, 10], zoom: 40 }}
        onCreated={(state) => {
          state.camera.lookAt(0, 0, 0);
          onCamera(state.camera as OrthographicCamera);
        }}
      >
        {driver && <CameraDriver rig={rig} />}
      </Canvas>
    </div>
  );
}

describe("CameraDriver remounted on the same camera", () => {
  it("still resets to the camera's original default pose after a turn", async () => {
    const rig = createCameraRig();
    let camera: OrthographicCamera | undefined;
    const onCamera = (c: OrthographicCamera) => {
      camera = c;
    };
    const screen = await render(<Stage rig={rig} driver onCamera={onCamera} />);
    await vi.waitFor(() => expect(camera).toBeDefined());
    const cam = camera as OrthographicCamera;
    const home = { p: cam.position.clone(), q: cam.quaternion.clone() };
    // Let the first frame run at the default view so the driver has seen it.
    await new Promise((r) => setTimeout(r, 200));

    rig.orbitBy(90);
    await vi.waitFor(() => expect(cam.position.z).toBeCloseTo(-10, 4), { timeout: 2000 });

    // CameraDriver alone unmounts and mounts again; the camera and the rig stay.
    await screen.rerender(<Stage rig={rig} driver={false} onCamera={onCamera} />);
    await screen.rerender(<Stage rig={rig} driver onCamera={onCamera} />);
    expect(rig.getSnapshot().azimuthOffset).toBe(90);
    await new Promise((r) => setTimeout(r, 200));

    rig.reset();
    await vi.waitFor(
      () => {
        expect(cam.position.x).toBeCloseTo(home.p.x, 4);
        expect(cam.position.y).toBeCloseTo(home.p.y, 4);
        expect(cam.position.z).toBeCloseTo(home.p.z, 4);
      },
      { timeout: 2000 },
    );
    expect(cam.quaternion.angleTo(home.q)).toBeCloseTo(0, 4);
  });
});
