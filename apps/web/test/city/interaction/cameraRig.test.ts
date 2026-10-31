import { describe, expect, it, vi } from "vitest";
import {
  createCameraRig,
  DEFAULT_VIEW,
  MAX_ZOOM,
  MIN_ZOOM,
} from "../../../src/city/interaction/cameraRig.ts";

describe("camera rig", () => {
  it("starts at the default view", () => {
    const rig = createCameraRig();
    expect(rig.getSnapshot()).toEqual(DEFAULT_VIEW);
    expect(rig.isDefault()).toBe(true);
  });

  it("orbits by degrees and wraps into (-180, 180]", () => {
    const rig = createCameraRig();
    rig.orbitBy(30);
    expect(rig.getSnapshot().azimuthOffset).toBe(30);
    rig.orbitBy(170);
    expect(rig.getSnapshot().azimuthOffset).toBe(-160);
    rig.orbitBy(-20);
    expect(rig.getSnapshot().azimuthOffset).toBe(180);
  });

  it("zooms by a factor and clamps", () => {
    const rig = createCameraRig();
    rig.zoomBy(1.5);
    expect(rig.getSnapshot().zoom).toBeCloseTo(1.5);
    rig.zoomBy(100);
    expect(rig.getSnapshot().zoom).toBe(MAX_ZOOM);
    rig.zoomBy(0.0001);
    expect(rig.getSnapshot().zoom).toBe(MIN_ZOOM);
  });

  it("reset restores the default view exactly", () => {
    const rig = createCameraRig();
    rig.orbitBy(77);
    rig.zoomBy(2);
    expect(rig.isDefault()).toBe(false);
    rig.reset();
    expect(rig.getSnapshot()).toEqual(DEFAULT_VIEW);
    expect(rig.isDefault()).toBe(true);
  });

  it("keeps the same snapshot object until the view changes, and notifies once per change", () => {
    const rig = createCameraRig();
    const listener = vi.fn();
    rig.subscribe(listener);
    const before = rig.getSnapshot();
    rig.reset();
    rig.orbitBy(0);
    rig.zoomBy(1);
    expect(rig.getSnapshot()).toBe(before);
    expect(listener).not.toHaveBeenCalled();
    rig.orbitBy(10);
    expect(rig.getSnapshot()).not.toBe(before);
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
