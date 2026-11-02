import type { Object3D, Sprite } from "three";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { crewMarkerLabel } from "./crew.ts";
import { pillMaterial } from "./resources.ts";
import { FRAME_WAIT, LEAD, mount, type Scene, sub, WORKING_MS } from "./testScene.tsx";
import { TINT_HEX } from "./tint.ts";

// M5.02 round 5: the "+N crew" marker with a real pointer (ARCHITECTURE 2.9: "clicking it fans
// the bots out briefly"). The scene has the real `InteractionLayer` next to the crew, which
// selects whatever is under the pointer on release and clears the selection over empty ground. A
// click on the marker must fan the bots out and leave the selection alone, and the marker must
// show the pointer cursor on hover like any other thing that can be clicked.
//
// The events are real (Playwright mouse through `userEvent`), at the marker's position projected
// through the live camera; nothing calls `onClick` directly.

const LABEL = crewMarkerLabel(1);
const MARKER_LOOKS = [
  pillMaterial(LABEL),
  pillMaterial(LABEL, TINT_HEX.red),
  pillMaterial(LABEL, TINT_HEX.amber),
];

const FOUR = [LEAD, sub("s1", "lead"), sub("s2", "lead"), sub("s3", "lead"), sub("s4", "lead")];

async function mountWithMarker(): Promise<{ scene: Scene; marker: Sprite }> {
  // The lead stands at the origin, where the default camera looks.
  const scene = await mount(FOUR, { anchor: [0, 0, 0], interaction: true, size: [480, 360] });
  await scene.frames(2);
  scene.clock.now = WORKING_MS;
  await vi.waitFor(() => expect(scene.shown("s3")).toBe(true), FRAME_WAIT);
  await vi.waitFor(() => expect(scene.spritesOf(MARKER_LOOKS)).toHaveLength(1), FRAME_WAIT);
  expect(scene.shown("s4")).toBe(false);
  await scene.frames(3);
  return { scene, marker: scene.spritesOf(MARKER_LOOKS)[0] as Sprite };
}

/** Where `object` is on the canvas, in px from the canvas's top-left corner. */
function onCanvas(scene: Scene, object: Object3D, lift = 0) {
  const camera = scene.root().camera;
  camera.updateMatrixWorld();
  const p = scene.at(object);
  p.y += lift;
  p.project(camera);
  const rect = scene.root().gl.domElement.getBoundingClientRect();
  return { x: ((p.x + 1) / 2) * rect.width, y: ((1 - p.y) / 2) * rect.height };
}

describe("the +N crew marker and a real pointer", () => {
  it("fans the crew out on a click and leaves the selection as it was", async () => {
    const { scene, marker } = await mountWithMarker();
    try {
      const canvas = scene.root().gl.domElement;
      scene.selection.select("s1");
      await scene.frames(3);

      await userEvent.click(canvas, { position: onCanvas(scene, marker) });
      await vi.waitFor(() => expect(scene.shown("s4")).toBe(true), FRAME_WAIT);
      // The marker is not an agent: the click did not clear or change what was selected.
      expect(scene.selection.getSnapshot()).toBe("s1");

      // And with nothing selected, it does not select anything either.
      scene.selection.select(null);
      await userEvent.click(canvas, { position: onCanvas(scene, marker) });
      await scene.frames(3);
      expect(scene.selection.getSnapshot()).toBeNull();
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("shows the pointer cursor while the pointer is over the marker, and not over bare ground", async () => {
    const { scene, marker } = await mountWithMarker();
    try {
      const canvas = scene.root().gl.domElement;
      // Bare ground: the top-left corner of the canvas has nothing in it.
      await userEvent.hover(canvas, { position: { x: 4, y: 4 } });
      await scene.frames(3);
      expect(canvas.style.cursor).toBe("");

      await userEvent.hover(canvas, { position: onCanvas(scene, marker) });
      await vi.waitFor(() => expect(canvas.style.cursor).toBe("pointer"), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("still selects a crew bot on a real click (the picking works in this scene)", async () => {
    const { scene } = await mountWithMarker();
    try {
      const bot = scene.bot("s3") as Object3D;
      await userEvent.click(scene.root().gl.domElement, { position: onCanvas(scene, bot, 0.3) });
      await vi.waitFor(() => expect(scene.selection.getSnapshot()).toBe("s3"), FRAME_WAIT);
    } finally {
      await scene.unmount();
    }
  }, 60_000);
});
