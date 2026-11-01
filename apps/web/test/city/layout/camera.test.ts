import { OrthographicCamera, Vector3 } from "three";
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

describe("projectToScreen agrees with a real three.js orthographic camera", () => {
  /** A camera posed and framed the way R3F frames a non-manual orthographic camera. */
  function realCamera(viewport: { width: number; height: number }, zoom: number) {
    const cam = new OrthographicCamera(
      -viewport.width / 2,
      viewport.width / 2,
      viewport.height / 2,
      -viewport.height / 2,
      CITY_CAMERA.near,
      CITY_CAMERA.far,
    );
    const p = cameraPosition(CITY_CAMERA);
    cam.position.set(p.x, p.y, p.z);
    cam.zoom = zoom;
    cam.lookAt(CITY_CAMERA.target.x, CITY_CAMERA.target.y, CITY_CAMERA.target.z);
    cam.updateProjectionMatrix();
    cam.updateMatrixWorld(true);
    return cam;
  }

  const points = [
    { x: 0, y: 0, z: 0 },
    { x: 10, y: 0, z: 0 },
    { x: 0, y: 0, z: 10 },
    { x: -12, y: 3, z: 7 },
    { x: 8, y: 6, z: -14 },
    { x: -17, y: 0, z: -17 },
    { x: 17, y: 5, z: 17 },
    { x: 3.3, y: 9, z: -2.1 },
  ];

  for (const viewport of [
    { width: 1280, height: 720 },
    { width: 390, height: 844 },
  ]) {
    it(`matches Vector3.project mapped to pixels at ${viewport.width}x${viewport.height}`, () => {
      const zoom = fitZoom(viewport, CITY_CAMERA, CITY_LAYOUT);
      const cam = realCamera(viewport, zoom);
      for (const point of points) {
        const ndc = new Vector3(point.x, point.y, point.z).project(cam);
        const expected = {
          x: ((ndc.x + 1) / 2) * viewport.width,
          y: ((1 - ndc.y) / 2) * viewport.height,
        };
        const actual = projectToScreen(point, zoom, viewport, CITY_CAMERA);
        expect(actual.x, `x of ${JSON.stringify(point)}`).toBeCloseTo(expected.x, 3);
        expect(actual.y, `y of ${JSON.stringify(point)}`).toBeCloseTo(expected.y, 3);
      }
    });

    it(`puts the camera target at the viewport centre at ${viewport.width}x${viewport.height}`, () => {
      const zoom = fitZoom(viewport, CITY_CAMERA, CITY_LAYOUT);
      const s = projectToScreen(CITY_CAMERA.target, zoom, viewport, CITY_CAMERA);
      expect(s.x).toBeCloseTo(viewport.width / 2, 6);
      expect(s.y).toBeCloseTo(viewport.height / 2, 6);
    });
  }
});
