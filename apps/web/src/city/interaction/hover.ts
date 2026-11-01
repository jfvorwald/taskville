import type { CameraRig } from "./cameraRig.ts";

/**
 * Whether a camera change should repick the hover: the pointer is over the canvas and is not
 * dragging the camera (a drag orbits or pans the city on every move, and the pick runs on release).
 */
export function repickOnCameraChange(state: { inside: boolean; dragging: boolean }): boolean {
  return state.inside && !state.dragging;
}

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
