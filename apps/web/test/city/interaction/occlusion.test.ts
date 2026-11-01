import { describe, expect, it } from "vitest";
import {
  markOccluders,
  rayHitsBox,
  stepFade,
  viewDirection,
} from "../../../src/city/interaction/occlusion.ts";
import { CITY_CAMERA, CITY_LAYOUT } from "../../../src/city/layout/index.ts";

const dir = { x: 0, y: 0, z: 0 };
viewDirection(CITY_CAMERA.azimuth, CITY_CAMERA.elevation, dir);

describe("viewDirection", () => {
  it("points from the scene toward the camera and has unit length", () => {
    expect(Math.hypot(dir.x, dir.y, dir.z)).toBeCloseTo(1);
    expect(dir.x).toBeGreaterThan(0);
    expect(dir.y).toBeGreaterThan(0);
    expect(dir.z).toBeGreaterThan(0);
  });
});

describe("rayHitsBox", () => {
  const box = { minX: 0, maxX: 2, minY: 0, maxY: 4, minZ: 0, maxZ: 2 };
  it("hits a box in front of the origin along the ray", () => {
    expect(rayHitsBox(-3, 1, -3, 1, 0, 1, box, 0)).toBe(true);
  });
  it("misses a box behind the origin", () => {
    expect(rayHitsBox(5, 1, 5, 1, 0, 1, box, 0)).toBe(false);
  });
  it("misses a ray that passes beside the box, unless padding reaches it", () => {
    expect(rayHitsBox(3.2, 1, -3, 0, 0, 1, box, 0)).toBe(false);
    expect(rayHitsBox(3.2, 1, -3, 0, 0, 1, box, 1.5)).toBe(true);
  });
  it("counts a start inside the box as occluded", () => {
    expect(rayHitsBox(1, 1, 1, 1, 0, 1, box, 0)).toBe(true);
  });
});

describe("markOccluders on the real layout", () => {
  const areas = CITY_LAYOUT.areas;
  const mask: boolean[] = [];

  it("marks no building for an agent standing at a front slot of its own building", () => {
    const slot = CITY_LAYOUT.slots.find((s) => s.areaId === "dispatch");
    if (!slot) throw new Error("no slot");
    markOccluders({ x: slot.x, y: 0.6, z: slot.z }, dir, areas, 0.2, mask);
    const own = areas.findIndex((a) => a.id === "dispatch");
    expect(mask[own]).toBe(false);
  });

  it("marks the building between the camera and an agent standing behind it", () => {
    const target = areas.find((a) => a.id === "review");
    if (!target) throw new Error("no area");
    const { cx, cz, halfX, halfZ } = target.footprint;
    // North-west of the building, on the far side from the south-east camera.
    markOccluders({ x: cx - halfX - 0.6, y: 0.6, z: cz - halfZ - 0.6 }, dir, areas, 0.2, mask);
    expect(mask[areas.indexOf(target)]).toBe(true);
  });

  it("fills the mask to the length of the area list and reuses the array", () => {
    const out: boolean[] = [true, true, true, true, true, true, true, true];
    markOccluders({ x: 0, y: 0.6, z: 0 }, dir, areas, 0, out);
    expect(out).toHaveLength(areas.length);
  });
});

describe("stepFade", () => {
  it("moves toward the target at 1/seconds per second and never overshoots", () => {
    expect(stepFade(1, 0.2, 0.1, 0.4)).toBeCloseTo(0.75, 5);
    expect(stepFade(1, 0.2, 10, 0.4)).toBe(0.2);
    expect(stepFade(0.2, 1, 10, 0.4)).toBe(1);
    expect(stepFade(0.5, 0.5, 1, 0.4)).toBe(0.5);
  });
});
