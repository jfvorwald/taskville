import { _roots } from "@react-three/fiber";
import { Vector3 } from "three";
import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { SessionProvider } from "../pairing/session.tsx";
import { SceneRoot } from "../SceneRoot.tsx";
import { CITY_CAMERA, cameraPosition } from "./layout/index.ts";

const frames = (n: number) =>
  new Promise<void>((resolve) => {
    const step = (left: number) =>
      left <= 0 ? resolve() : requestAnimationFrame(() => step(left - 1));
    step(n);
  });

/** The camera R3F draws with, read from the mounted canvas root. */
function drawnCamera() {
  for (const root of _roots.values()) return root.store.getState().camera;
  return undefined;
}

describe("the drawn camera pose (SceneRoot with the city mounted)", () => {
  it("is the city's orthographic camera and looks at CITY_CAMERA.target after the first frames", async () => {
    await render(
      <div style={{ width: 800, height: 600 }}>
        <SessionProvider value="test-session">
          <SceneRoot />
        </SessionProvider>
      </div>,
    );
    await frames(5);

    const camera = drawnCamera();
    expect(camera, "an R3F root is mounted").toBeDefined();
    if (!camera) return;
    expect((camera as { isOrthographicCamera?: boolean }).isOrthographicCamera).toBe(true);

    const p = cameraPosition(CITY_CAMERA);
    expect(camera.position.x).toBeCloseTo(p.x, 3);
    expect(camera.position.y).toBeCloseTo(p.y, 3);
    expect(camera.position.z).toBeCloseTo(p.z, 3);

    camera.updateMatrixWorld(true);
    const actual = camera.getWorldDirection(new Vector3());
    const t = CITY_CAMERA.target;
    const expected = new Vector3(t.x - p.x, t.y - p.y, t.z - p.z).normalize();
    // The scene origin (0, 0, 0) is 1.5 m below the target; looking there is the bug.
    expect(actual.x).toBeCloseTo(expected.x, 4);
    expect(actual.y).toBeCloseTo(expected.y, 4);
    expect(actual.z).toBeCloseTo(expected.z, 4);
  });
});
