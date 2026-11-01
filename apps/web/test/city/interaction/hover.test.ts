import { describe, expect, it, vi } from "vitest";
import { createCameraRig } from "../../../src/city/interaction/cameraRig.ts";
import { markHoverDirtyOnCameraChange } from "../../../src/city/interaction/hover.ts";

// M3.24 (roborev 5618 #1): zooming or turning with the camera buttons moves the city under a
// still pointer, so the hover pick has to run again. The layer marks hover dirty whenever the
// camera rig changes; this is the seam that wires the two together.

describe("markHoverDirtyOnCameraChange", () => {
  it("marks hover dirty when the rig zooms, turns or resets", () => {
    const rig = createCameraRig();
    const markDirty = vi.fn();
    markHoverDirtyOnCameraChange(rig, markDirty, () => true);
    rig.zoomBy(1.5);
    expect(markDirty).toHaveBeenCalledTimes(1);
    rig.orbitBy(30);
    expect(markDirty).toHaveBeenCalledTimes(2);
    rig.reset();
    expect(markDirty).toHaveBeenCalledTimes(3);
  });

  it("does not mark dirty when the view did not change", () => {
    const rig = createCameraRig();
    const markDirty = vi.fn();
    markHoverDirtyOnCameraChange(rig, markDirty, () => true);
    rig.reset();
    rig.orbitBy(0);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe that stops further marks", () => {
    const rig = createCameraRig();
    const markDirty = vi.fn();
    const stop = markHoverDirtyOnCameraChange(rig, markDirty, () => true);
    stop();
    rig.zoomBy(2);
    expect(markDirty).not.toHaveBeenCalled();
  });

  // Finding on the M3.24 fix: after pointerleave the stored pointer position is stale (or the
  // initial ndc 0,0), so a camera change must not repick hover and glow whatever is mid-screen.
  // `pointerInside` is read at change time, so the layer can flip it on pointerenter/leave.
  describe("pointer presence", () => {
    it("marks dirty on zoom, orbit and reset while the pointer is inside", () => {
      const rig = createCameraRig();
      const markDirty = vi.fn();
      markHoverDirtyOnCameraChange(rig, markDirty, () => true);
      rig.zoomBy(1.5);
      rig.orbitBy(30);
      rig.reset();
      expect(markDirty).toHaveBeenCalledTimes(3);
    });

    it("does not mark dirty on zoom, orbit or reset after the pointer left", () => {
      const rig = createCameraRig();
      const markDirty = vi.fn();
      let inside = true;
      markHoverDirtyOnCameraChange(rig, markDirty, () => inside);
      rig.zoomBy(1.5);
      expect(markDirty).toHaveBeenCalledTimes(1);

      inside = false; // pointerleave
      rig.zoomBy(1.5);
      rig.orbitBy(30);
      rig.reset();
      expect(markDirty).toHaveBeenCalledTimes(1);
    });

    it("does not mark dirty when the pointer was never over the canvas", () => {
      const rig = createCameraRig();
      const markDirty = vi.fn();
      markHoverDirtyOnCameraChange(rig, markDirty, () => false);
      rig.zoomBy(2);
      rig.orbitBy(45);
      expect(markDirty).not.toHaveBeenCalled();
    });

    it("marks dirty again once the pointer re-enters", () => {
      const rig = createCameraRig();
      const markDirty = vi.fn();
      let inside = true;
      markHoverDirtyOnCameraChange(rig, markDirty, () => inside);

      inside = false; // pointerleave
      rig.zoomBy(1.5);
      expect(markDirty).not.toHaveBeenCalled();

      inside = true; // pointerenter / pointermove
      rig.orbitBy(30);
      expect(markDirty).toHaveBeenCalledTimes(1);
      rig.zoomBy(0.8);
      expect(markDirty).toHaveBeenCalledTimes(2);
      rig.reset();
      expect(markDirty).toHaveBeenCalledTimes(3);
    });
  });
});
