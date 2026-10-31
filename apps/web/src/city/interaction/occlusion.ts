import type { WorkAreaLayout } from "../layout/index.ts";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export interface Box {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  minZ: number;
  maxZ: number;
}

const rad = (deg: number) => (deg * Math.PI) / 180;
const ROOF = 0.25;
const scratchBox: Box = { minX: 0, maxX: 0, minY: 0, maxY: 0, minZ: 0, maxZ: 0 };

/** Unit vector from the scene toward the camera, written into `out` (no allocation). */
export function viewDirection(azimuthDeg: number, elevationDeg: number, out: Vec3): Vec3 {
  const az = rad(azimuthDeg);
  const el = rad(elevationDeg);
  out.x = Math.cos(el) * Math.sin(az);
  out.y = Math.sin(el);
  out.z = Math.cos(el) * Math.cos(az);
  return out;
}

/**
 * Does the ray from (ox, oy, oz) along (dx, dy, dz) pass through `box` (grown by `pad` on every
 * side) ahead of the origin? A start inside the box counts: the building hides the point.
 * Slab test, scalars only.
 */
export function rayHitsBox(
  ox: number,
  oy: number,
  oz: number,
  dx: number,
  dy: number,
  dz: number,
  box: Box,
  pad: number,
): boolean {
  let tMin = Number.NEGATIVE_INFINITY;
  let tMax = Number.POSITIVE_INFINITY;
  // x
  if (Math.abs(dx) < 1e-9) {
    if (ox < box.minX - pad || ox > box.maxX + pad) return false;
  } else {
    const a = (box.minX - pad - ox) / dx;
    const b = (box.maxX + pad - ox) / dx;
    tMin = Math.max(tMin, Math.min(a, b));
    tMax = Math.min(tMax, Math.max(a, b));
  }
  // y
  if (Math.abs(dy) < 1e-9) {
    if (oy < box.minY - pad || oy > box.maxY + pad) return false;
  } else {
    const a = (box.minY - pad - oy) / dy;
    const b = (box.maxY + pad - oy) / dy;
    tMin = Math.max(tMin, Math.min(a, b));
    tMax = Math.min(tMax, Math.max(a, b));
  }
  // z
  if (Math.abs(dz) < 1e-9) {
    if (oz < box.minZ - pad || oz > box.maxZ + pad) return false;
  } else {
    const a = (box.minZ - pad - oz) / dz;
    const b = (box.maxZ + pad - oz) / dz;
    tMin = Math.max(tMin, Math.min(a, b));
    tMax = Math.min(tMax, Math.max(a, b));
  }
  return tMax >= Math.max(tMin, 0) && tMax > 0;
}

/**
 * For each area (same order as `areas`), is its building between `origin` and the camera? Writes
 * booleans into `out` and trims it to `areas.length`. The box is the footprint up to the roof.
 */
export function markOccluders(
  origin: Vec3,
  towardCamera: Vec3,
  areas: readonly WorkAreaLayout[],
  pad: number,
  out: boolean[],
): boolean[] {
  out.length = areas.length;
  for (let i = 0; i < areas.length; i++) {
    const area = areas[i];
    if (area === undefined) continue;
    const f = area.footprint;
    scratchBox.minX = f.cx - f.halfX;
    scratchBox.maxX = f.cx + f.halfX;
    scratchBox.maxY = area.height + ROOF;
    scratchBox.minZ = f.cz - f.halfZ;
    scratchBox.maxZ = f.cz + f.halfZ;
    out[i] = rayHitsBox(
      origin.x,
      origin.y,
      origin.z,
      towardCamera.x,
      towardCamera.y,
      towardCamera.z,
      scratchBox,
      pad,
    );
  }
  return out;
}

/** Moves `current` toward `target` by `dt / seconds`, never past it. */
export function stepFade(current: number, target: number, dt: number, seconds: number): number {
  const step = seconds <= 0 ? Number.POSITIVE_INFINITY : dt / seconds;
  if (current < target) return Math.min(target, current + step);
  return Math.max(target, current - step);
}
