import type { CameraRig } from "./cameraRig.ts";

/**
 * Zooming or turning with the camera buttons moves the city under a still pointer, so the hover
 * pick has to run again. Calls `markDirty` on a camera change while `pointerInside()` is true;
 * once the pointer has left the canvas there is nothing to hover, and a repick would relight the
 * glow. Returns the unsubscribe.
 */
export function markHoverDirtyOnCameraChange(
  rig: CameraRig,
  markDirty: () => void,
  pointerInside: () => boolean,
): () => void {
  return rig.subscribe(() => {
    if (pointerInside()) markDirty();
  });
}
