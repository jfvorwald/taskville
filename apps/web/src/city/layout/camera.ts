import type { CityLayout } from "./types.ts";

/**
 * Fixed orthographic isometric framing: the camera looks at `target` from a true isometric
 * direction (45 degrees around, about 35.26 degrees down). Orbit and zoom controls are a later
 * ticket; this is the default and the reset pose.
 */
export interface CityCamera {
  target: { x: number; y: number; z: number };
  /** Degrees around the y axis; 45 puts the camera over the south-east corner. */
  azimuth: number;
  /** Degrees above the horizon. */
  elevation: number;
  distance: number;
  near: number;
  far: number;
  /** Extra height above the tallest building kept in frame (roofs, masts, chimneys). */
  headroom: number;
  /** Fraction of the viewport left empty around the city. */
  margin: number;
}

export const CITY_CAMERA: CityCamera = {
  target: { x: 0, y: 1.5, z: 0 },
  azimuth: 45,
  elevation: (Math.atan(1 / Math.SQRT2) * 180) / Math.PI,
  distance: 70,
  near: 0.1,
  far: 220,
  headroom: 3,
  margin: 0.06,
};

const rad = (deg: number) => (deg * Math.PI) / 180;

export function cameraPosition(cam: CityCamera): { x: number; y: number; z: number } {
  const az = rad(cam.azimuth);
  const el = rad(cam.elevation);
  return {
    x: cam.target.x + cam.distance * Math.cos(el) * Math.sin(az),
    y: cam.target.y + cam.distance * Math.sin(el),
    z: cam.target.z + cam.distance * Math.cos(el) * Math.cos(az),
  };
}

interface Point3 {
  x: number;
  y: number;
  z: number;
}

/** Camera right and up unit vectors (the screen axes in world space). */
function screenAxes(cam: CityCamera): { right: Point3; up: Point3 } {
  const az = rad(cam.azimuth);
  const el = rad(cam.elevation);
  // Forward points from the camera to the target; right = forward x worldUp, up = right x forward.
  const forward = {
    x: -Math.cos(el) * Math.sin(az),
    y: -Math.sin(el),
    z: -Math.cos(el) * Math.cos(az),
  };
  const right = { x: -forward.z, y: 0, z: forward.x };
  const rl = Math.hypot(right.x, right.z);
  right.x /= rl;
  right.z /= rl;
  const up = {
    x: right.y * forward.z - right.z * forward.y,
    y: right.z * forward.x - right.x * forward.z,
    z: right.x * forward.y - right.y * forward.x,
  };
  return { right, up };
}

export interface Viewport {
  width: number;
  height: number;
}

/** Where a world point lands on screen, in CSS pixels from the top-left, at `zoom` px per meter. */
export function projectToScreen(
  point: Point3,
  zoom: number,
  viewport: Viewport,
  cam: CityCamera,
): { x: number; y: number } {
  const { right, up } = screenAxes(cam);
  const d = { x: point.x - cam.target.x, y: point.y - cam.target.y, z: point.z - cam.target.z };
  return {
    x: viewport.width / 2 + zoom * (d.x * right.x + d.y * right.y + d.z * right.z),
    y: viewport.height / 2 - zoom * (d.x * up.x + d.y * up.y + d.z * up.z),
  };
}

/**
 * The orthographic zoom (pixels per meter) that keeps the whole ground slab and the tallest
 * building inside the viewport with the camera's margin. Always positive.
 */
export function fitZoom(viewport: Viewport, cam: CityCamera, layout: CityLayout): number {
  const { minX, maxX, minZ, maxZ } = layout.bounds;
  const top = Math.max(0, ...layout.areas.map((a) => a.height)) + cam.headroom;
  const { right, up } = screenAxes(cam);
  let halfW = 0;
  let halfH = 0;
  for (const x of [minX, maxX]) {
    for (const z of [minZ, maxZ]) {
      for (const y of [0, top]) {
        const d = { x: x - cam.target.x, y: y - cam.target.y, z: z - cam.target.z };
        halfW = Math.max(halfW, Math.abs(d.x * right.x + d.y * right.y + d.z * right.z));
        halfH = Math.max(halfH, Math.abs(d.x * up.x + d.y * up.y + d.z * up.z));
      }
    }
  }
  const usable = 1 - cam.margin;
  const zoom = Math.min(
    Math.max(viewport.width, 1) / 2 / halfW,
    Math.max(viewport.height, 1) / 2 / halfH,
  );
  return zoom * usable;
}
