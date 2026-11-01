import { _roots } from "@react-three/fiber";
import { Vector3 } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { SessionProvider } from "../pairing/session.tsx";
import { SceneRoot } from "../SceneRoot.tsx";
import { CITY_CAMERA, cameraPosition } from "./layout/index.ts";

/** The mounted canvas root's state, if R3F has created one. */
function mountedRoot() {
  for (const root of _roots.values()) return root.store.getState();
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
    // Wait for the condition, not a frame count: the root exists and has drawn, so its camera is
    // the one drawn with. The full browser suite runs files in parallel on software WebGL
    // (SwiftShader), where a page can go several seconds without a frame (4.6 s measured).
    await vi.waitFor(
      () =>
        expect(mountedRoot()?.gl.info.render.frame ?? 0, "an R3F root has drawn").toBeGreaterThan(
          0,
        ),
      { timeout: 10_000 },
    );

    const camera = mountedRoot()?.camera;
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
  }, 30_000);
});
