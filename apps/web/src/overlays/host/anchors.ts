import {
  type ProjectedPoint,
  type ProjectionOptions,
  projectToViewport,
  type Viewport,
} from "./projection.ts";
import type { AnchorSource, WorldPoint } from "./types.ts";

/**
 * The shared store between the city (which knows where things are in the world), the camera
 * bridge (which knows how the world maps to the screen) and the DOM overlays (which follow it).
 * Plain subscribe/version store, so it carries no React and the city can write it every frame.
 */
export function createAnchorSource(): AnchorSource {
  const anchors = new Map<string, WorldPoint>();
  const listeners = new Set<() => void>();
  let matrix: number[] | null = null;
  let viewport: Viewport | null = null;
  let version = 0;

  const bump = () => {
    version++;
    for (const listener of [...listeners]) listener();
  };
  const same = (a: WorldPoint | undefined, b: WorldPoint) =>
    a !== undefined && a[0] === b[0] && a[1] === b[1] && a[2] === b[2];

  return {
    setAnchor(id, position) {
      if (same(anchors.get(id), position)) return;
      anchors.set(id, [position[0], position[1], position[2]]);
      bump();
    },
    removeAnchor(id) {
      if (anchors.delete(id)) bump();
    },
    replaceAnchors(prefix, next) {
      let changed = false;
      for (const id of [...anchors.keys()]) {
        if (id.startsWith(prefix) && !(id in next)) {
          anchors.delete(id);
          changed = true;
        }
      }
      for (const [id, position] of Object.entries(next)) {
        if (same(anchors.get(id), position)) continue;
        anchors.set(id, [position[0], position[1], position[2]]);
        changed = true;
      }
      if (changed) bump();
    },
    getAnchor: (id) => anchors.get(id),
    setProjection(viewProjection, size) {
      const sameMatrix =
        matrix !== null &&
        matrix.length === viewProjection.length &&
        matrix.every((v, i) => v === viewProjection[i]);
      const sameSize = viewport?.width === size.width && viewport?.height === size.height;
      if (sameMatrix && sameSize) return;
      matrix = Array.from(viewProjection);
      viewport = { width: size.width, height: size.height };
      bump();
    },
    project(id, options?: ProjectionOptions): ProjectedPoint | null {
      const position = anchors.get(id);
      if (!position || !matrix || !viewport) return null;
      return projectToViewport(position, matrix, viewport, options);
    },
    getViewport: () => viewport,
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getVersion: () => version,
  };
}
