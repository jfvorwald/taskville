import { Canvas } from "@react-three/fiber";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { createBurst } from "./burst.ts";

// Particles are unlit MeshBasicMaterial quads, so on screen they must be the palette colours
// exactly. R3F's default renderer applies ACES tone mapping, which shifts any material that does
// not set `toneMapped: false`; this test draws a burst through a real WebGL canvas and reads the
// pixels back in the same frame, so it is deterministic (no screenshots, no timing).

/** GOLD from Celebrations.tsx: what a high-five burst is coloured with. */
const GOLD = ["#ffd166", "#fff3b0"];
const BACKGROUND = "#11141a";

/** Per-channel difference allowed from a palette colour (antialiasing never touches the interior). */
const TOLERANCE = 6;

/** Particles at birth are 0.08 m; at this distance that is well over 100 pixels of GOLD in total. */
const MIN_GOLD_PIXELS = 100;

const near = (a: number[], b: number[]): boolean =>
  a.every((v, k) => Math.abs(v - (b[k] ?? 0)) <= TOLERANCE);

const hex = (h: string): number[] => [1, 3, 5].map((i) => Number.parseInt(h.slice(i, i + 2), 16));

interface Frame {
  gold: number;
  /** The background colour at pixel (2, 2), proves the readback is a real frame, not a blank copy. */
  corner: number[];
}

/**
 * Renders one frame of a high-five sized GOLD burst (`emit` false leaves the burst unstarted) and
 * counts the pixels within TOLERANCE of a GOLD colour. The canvas is read back in the same task
 * that rendered it, while the WebGL drawing buffer is still intact.
 */
async function drawBurst(emit: boolean): Promise<Frame> {
  let result: Frame | undefined;
  await render(
    <div style={{ width: 400, height: 300 }}>
      <Canvas
        dpr={1}
        frameloop="never"
        camera={{ position: [0, 0.3, 1.6], fov: 50 }}
        onCreated={(state) => {
          state.camera.lookAt(0, 0.3, 0);
          state.scene.background = null;
          const burst = createBurst({
            capacity: 14,
            lifetimeMs: 700,
            speed: 1.6,
            size: 0.08,
            gravity: 2,
            colors: GOLD,
          });
          state.scene.add(burst.mesh);
          if (emit) burst.emit(0, 0, 0, 14, 1000);
          burst.update(1100); // 100 ms into a 700 ms life: particles are still large
          state.gl.setClearColor(BACKGROUND, 1);
          state.gl.render(state.scene, state.camera);

          const flat = document.createElement("canvas");
          flat.width = state.gl.domElement.width;
          flat.height = state.gl.domElement.height;
          const ctx = flat.getContext("2d", { willReadFrequently: true });
          if (!ctx) throw new Error("no 2d context");
          ctx.drawImage(state.gl.domElement, 0, 0);
          const { data } = ctx.getImageData(0, 0, flat.width, flat.height);
          const palette = GOLD.map(hex);
          let gold = 0;
          for (let i = 0; i < data.length; i += 4) {
            if (palette.some((c) => near([data[i] ?? 0, data[i + 1] ?? 0, data[i + 2] ?? 0], c)))
              gold += 1;
          }
          const at = (2 * flat.width + 2) * 4;
          result = { gold, corner: [data[at] ?? -1, data[at + 1] ?? -1, data[at + 2] ?? -1] };
          burst.dispose();
        }}
      />
    </div>,
  );
  await vi.waitFor(() => expect(result).toBeDefined());
  console.log(`burst e2e: emit ${emit}, gold pixels ${result?.gold}, corner ${result?.corner}`);
  return result as Frame;
}

describe("createBurst drawn through a real WebGL canvas", () => {
  it("draws particles in exact GOLD palette colours (not tone mapped)", async () => {
    const frame = await drawBurst(true);
    expect(
      near(frame.corner, hex(BACKGROUND)),
      `the readback is a real frame; corner ${frame.corner}`,
    ).toBe(true);
    expect(
      frame.gold,
      `pixels within ${TOLERANCE} per channel of a GOLD colour (at least ${MIN_GOLD_PIXELS})`,
    ).toBeGreaterThanOrEqual(MIN_GOLD_PIXELS);
  });

  it("draws no GOLD pixels when nothing was emitted", async () => {
    const frame = await drawBurst(false);
    expect(
      near(frame.corner, hex(BACKGROUND)),
      `the readback is a real frame; corner ${frame.corner}`,
    ).toBe(true);
    expect(frame.gold).toBe(0);
  });
});
