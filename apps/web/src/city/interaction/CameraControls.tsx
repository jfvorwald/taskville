import { useSyncExternalStore } from "react";
import { InteractiveRegion } from "../../overlays/host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayProps } from "../../overlays/host/types.ts";
import styles from "./camera-controls.module.css";
import { cameraRig } from "./cameraRig.ts";

const ORBIT_STEP = 15;
const ZOOM_STEP = 1.25;

/**
 * Turn, zoom and reset buttons for the city camera. The wrapper also carries the current view and
 * the selected id as data attributes, so automation can read them without reaching into the canvas.
 */
export function CameraControls({ selection }: OverlayProps) {
  const view = useSyncExternalStore(
    cameraRig.subscribe,
    cameraRig.getSnapshot,
    cameraRig.getSnapshot,
  );
  const isDefault = view.azimuthOffset === 0 && view.zoom === 1;
  return (
    <InteractiveRegion
      className={styles.bar}
      role="group"
      aria-label="Camera"
      data-testid="camera-controls"
      data-azimuth-offset={view.azimuthOffset}
      data-zoom={view.zoom}
      data-selected-id={selection.selectedId ?? ""}
    >
      <button
        type="button"
        className={styles.button}
        aria-label="Turn left"
        onClick={() => cameraRig.orbitBy(-ORBIT_STEP)}
      >
        {"↶"}
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Turn right"
        onClick={() => cameraRig.orbitBy(ORBIT_STEP)}
      >
        {"↷"}
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Zoom in"
        onClick={() => cameraRig.zoomBy(ZOOM_STEP)}
      >
        +
      </button>
      <button
        type="button"
        className={styles.button}
        aria-label="Zoom out"
        onClick={() => cameraRig.zoomBy(1 / ZOOM_STEP)}
      >
        {"−"}
      </button>
      <button
        type="button"
        className={styles.button}
        disabled={isDefault}
        onClick={() => cameraRig.reset()}
      >
        Reset view
      </button>
    </InteractiveRegion>
  );
}

export const cameraControlsOverlay: OverlayDefinition = {
  id: "camera-controls",
  slot: "header",
  modes: ["live", "history"],
  Component: CameraControls,
};
