export interface Viewport {
  width: number;
  height: number;
}

export interface ProjectedPoint {
  /** CSS pixels from the left of the layer. */
  x: number;
  /** CSS pixels from the top of the layer. */
  y: number;
  /** In front of the camera, between the near and far planes, and on screen (within `margin`). */
  visible: boolean;
}

export interface ProjectionOptions {
  /** How far outside the viewport, in px, a point still counts as visible. Default 0. */
  margin?: number;
}

/**
 * Projects a world point through a column-major 4x4 view-projection matrix (the layout of
 * three.js `Matrix4.elements`) to layer pixels, with +y down the screen.
 */
export function projectToViewport(
  point: readonly [number, number, number],
  viewProjection: ArrayLike<number>,
  viewport: Viewport,
  options: ProjectionOptions = {},
): ProjectedPoint {
  const [px, py, pz] = point;
  const m = (i: number) => viewProjection[i] ?? 0;
  const cx = m(0) * px + m(4) * py + m(8) * pz + m(12);
  const cy = m(1) * px + m(5) * py + m(9) * pz + m(13);
  const cz = m(2) * px + m(6) * py + m(10) * pz + m(14);
  const cw = m(3) * px + m(7) * py + m(11) * pz + m(15);

  // w <= 0 is at or behind the camera plane; dividing would mirror the point into view.
  if (!(cw > 1e-9) || !(viewport.width > 0) || !(viewport.height > 0)) {
    return { x: Number.NaN, y: Number.NaN, visible: false };
  }
  const ndcX = cx / cw;
  const ndcY = cy / cw;
  const ndcZ = cz / cw;
  const x = (ndcX * 0.5 + 0.5) * viewport.width;
  const y = (1 - (ndcY * 0.5 + 0.5)) * viewport.height;
  const margin = options.margin ?? 0;
  const visible =
    ndcZ >= -1 &&
    ndcZ <= 1 &&
    x >= -margin &&
    x <= viewport.width + margin &&
    y >= -margin &&
    y <= viewport.height + margin;
  return { x, y, visible };
}
