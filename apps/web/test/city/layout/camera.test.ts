import { describe, expect, it } from "vitest";
import {
  CITY_CAMERA,
  CITY_LAYOUT,
  cameraPosition,
  fitZoom,
  projectToScreen,
} from "../../../src/city/layout/index.ts";

describe("fixed orthographic isometric camera", () => {
  it("looks along a true isometric direction (about 35.26 degrees down, 45 degrees around)", () => {
    const p = cameraPosition(CITY_CAMERA);
    const dx = p.x - CITY_CAMERA.target.x;
    const dy = p.y - CITY_CAMERA.target.y;
    const dz = p.z - CITY_CAMERA.target.z;
    expect(dx).toBeCloseTo(dz, 6);
    expect(dx).toBeGreaterThan(0);
    const elevation = (Math.atan2(dy, Math.hypot(dx, dz)) * 180) / Math.PI;
    expect(elevation).toBeCloseTo(35.264, 2);
    expect(Math.hypot(dx, dy, dz)).toBeCloseTo(CITY_CAMERA.distance, 6);
  });

  it("fits the whole ground slab and the tallest building in the viewport with a margin", () => {
    for (const viewport of [
      { width: 1280, height: 720 },
      { width: 1920, height: 1080 },
      { width: 800, height: 800 },
      { width: 390, height: 844 },
    ]) {
      const zoom = fitZoom(viewport, CITY_CAMERA, CITY_LAYOUT);
      expect(zoom).toBeGreaterThan(0);
      const { minX, maxX, minZ, maxZ } = CITY_LAYOUT.bounds;
      const tallest = Math.max(...CITY_LAYOUT.areas.map((a) => a.height));
      const corners = [
        [minX, 0, minZ],
        [minX, 0, maxZ],
        [maxX, 0, minZ],
        [maxX, 0, maxZ],
        [minX, tallest, minZ],
        [maxX, tallest, minZ],
        [minX, tallest, maxZ],
        [maxX, tallest, maxZ],
      ] as const;
      for (const [x, y, z] of corners) {
        const s = projectToScreen({ x, y, z }, zoom, viewport, CITY_CAMERA);
        expect(s.x, `${viewport.width}x${viewport.height} x`).toBeGreaterThanOrEqual(0);
        expect(s.x).toBeLessThanOrEqual(viewport.width);
        expect(s.y).toBeGreaterThanOrEqual(0);
        expect(s.y).toBeLessThanOrEqual(viewport.height);
      }
    }
  });

  it("scales with the viewport and is bounded by the tighter axis", () => {
    const small = fitZoom({ width: 640, height: 360 }, CITY_CAMERA, CITY_LAYOUT);
    const big = fitZoom({ width: 1280, height: 720 }, CITY_CAMERA, CITY_LAYOUT);
    expect(big).toBeCloseTo(small * 2, 6);
    const tall = fitZoom({ width: 400, height: 2000 }, CITY_CAMERA, CITY_LAYOUT);
    const wide = fitZoom({ width: 2000, height: 400 }, CITY_CAMERA, CITY_LAYOUT);
    expect(tall).toBeLessThan(wide * 2);
  });

  it("is safe on a zero-size viewport", () => {
    expect(fitZoom({ width: 0, height: 0 }, CITY_CAMERA, CITY_LAYOUT)).toBeGreaterThan(0);
  });
});
