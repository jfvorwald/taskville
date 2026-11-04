/**
 * The user's adjustment to the default isometric camera: a turn about the vertical axis (degrees)
 * and a zoom factor on top of the fit-to-canvas zoom. `reset` returns to the default view, which
 * is exactly what M3.04's `CityCamera` shows. Pure state; `CameraDriver` applies it each frame.
 */
export interface CameraView {
  /** Degrees added to the default azimuth, wrapped into (-180, 180]. */
  readonly azimuthOffset: number;
  /** Multiplies the fit zoom. 1 is the default framing. */
  readonly zoom: number;
  /** Slides the view over the ground in world units (x, z), after the turn. 0 is the default. */
  readonly panX: number;
  readonly panZ: number;
}

export const DEFAULT_VIEW: CameraView = Object.freeze({
  azimuthOffset: 0,
  zoom: 1,
  panX: 0,
  panZ: 0,
});
export const MIN_ZOOM = 0.6;
export const MAX_ZOOM = 3;

export interface CameraRig {
  getSnapshot(): CameraView;
  subscribe(listener: () => void): () => void;
  orbitBy(degrees: number): void;
  zoomBy(factor: number): void;
  /** Slides the view over the ground by a world offset; turn and zoom are unchanged. */
  panBy(dx: number, dz: number): void;
  reset(): void;
  isDefault(): boolean;
}

function wrapDegrees(d: number): number {
  let v = d % 360;
  if (v > 180) v -= 360;
  if (v <= -180) v += 360;
  return v;
}

export function createCameraRig(): CameraRig {
  let view: CameraView = DEFAULT_VIEW;
  const listeners = new Set<() => void>();
  const set = (next: CameraView) => {
    if (
      next.azimuthOffset === view.azimuthOffset &&
      next.zoom === view.zoom &&
      next.panX === view.panX &&
      next.panZ === view.panZ
    ) {
      return;
    }
    view = next;
    for (const listener of [...listeners]) listener();
  };
  return {
    getSnapshot: () => view,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    orbitBy(degrees) {
      set({ ...view, azimuthOffset: wrapDegrees(view.azimuthOffset + degrees) });
    },
    panBy(dx, dz) {
      set({ ...view, panX: view.panX + dx, panZ: view.panZ + dz });
    },
    zoomBy(factor) {
      const zoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, view.zoom * factor));
      set({ ...view, zoom });
    },
    reset: () => set(DEFAULT_VIEW),
    isDefault: () =>
      view.azimuthOffset === 0 && view.zoom === 1 && view.panX === 0 && view.panZ === 0,
  };
}

/** The app-wide camera adjustment, shared by the 3D driver and the DOM controls. */
export const cameraRig: CameraRig = createCameraRig();
