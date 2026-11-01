import { describe, expect, it, vi } from "vitest";
import { createCameraRig } from "../../../src/city/interaction/cameraRig.ts";
import {
  markHoverDirtyOnCameraChange,
  repickOnCameraChange,
} from "../../../src/city/interaction/hover.ts";

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

// M3.24 (roborev 5704): dragging to orbit changes the camera while the stored pick coordinates stay
// put, so a camera-triggered repick during a drag highlights whatever sat under the OLD position
// and replaces the grabbing cursor. The release handler already requests a fresh pick, so the
// camera-change invalidation is skipped while a drag is active.
describe("repickOnCameraChange", () => {
  it("is true only when the pointer is inside and no drag is active", () => {
    expect(repickOnCameraChange({ inside: true, dragging: false })).toBe(true);
    expect(repickOnCameraChange({ inside: true, dragging: true })).toBe(false);
    expect(repickOnCameraChange({ inside: false, dragging: false })).toBe(false);
    expect(repickOnCameraChange({ inside: false, dragging: true })).toBe(false);
  });

  describe("as the predicate of markHoverDirtyOnCameraChange", () => {
    it("does not mark dirty when the camera orbits during a drag", () => {
      const rig = createCameraRig();
      const markDirty = vi.fn();
      const state = { inside: true, dragging: true };
      markHoverDirtyOnCameraChange(rig, markDirty, () => repickOnCameraChange(state));
      rig.orbitBy(10);
      rig.orbitBy(10);
      expect(markDirty).not.toHaveBeenCalled();
    });

    it("marks dirty on a camera change when inside and not dragging", () => {
      const rig = createCameraRig();
      const markDirty = vi.fn();
      const state = { inside: true, dragging: false };
      markHoverDirtyOnCameraChange(rig, markDirty, () => repickOnCameraChange(state));
      rig.zoomBy(1.5);
      expect(markDirty).toHaveBeenCalledTimes(1);
    });

    it("never marks dirty when the pointer is outside, dragging or not", () => {
      const rig = createCameraRig();
      const markDirty = vi.fn();
      const state = { inside: false, dragging: false };
      markHoverDirtyOnCameraChange(rig, markDirty, () => repickOnCameraChange(state));
      rig.zoomBy(1.5);
      state.dragging = true;
      rig.orbitBy(30);
      expect(markDirty).not.toHaveBeenCalled();
    });

    it("resumes marking after the drag ends", () => {
      const rig = createCameraRig();
      const markDirty = vi.fn();
      const state = { inside: true, dragging: true };
      markHoverDirtyOnCameraChange(rig, markDirty, () => repickOnCameraChange(state));
      rig.orbitBy(10);
      expect(markDirty).not.toHaveBeenCalled();
      state.dragging = false; // release
      rig.zoomBy(1.5);
      expect(markDirty).toHaveBeenCalledTimes(1);
    });
  });
});
