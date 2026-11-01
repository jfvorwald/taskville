import type { CameraRig } from "./cameraRig.ts";

/**
 * Zooming or turning with the camera buttons moves the city under a still pointer, so the hover
 * pick has to run again. Calls `markDirty` on every camera change; returns the unsubscribe.
 */
export function markHoverDirtyOnCameraChange(rig: CameraRig, markDirty: () => void): () => void {
  return rig.subscribe(markDirty);
}
