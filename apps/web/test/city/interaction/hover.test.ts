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
    markHoverDirtyOnCameraChange(rig, markDirty);
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
    markHoverDirtyOnCameraChange(rig, markDirty);
    rig.reset();
    rig.orbitBy(0);
    expect(markDirty).not.toHaveBeenCalled();
  });

  it("returns an unsubscribe that stops further marks", () => {
    const rig = createCameraRig();
    const markDirty = vi.fn();
    const stop = markHoverDirtyOnCameraChange(rig, markDirty);
    stop();
    rig.zoomBy(2);
    expect(markDirty).not.toHaveBeenCalled();
  });
});
