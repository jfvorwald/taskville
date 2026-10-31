import type { ActivityView } from "./types.ts";

// Small work loops at the workstation (ARCHITECTURE 2.2): hammering at the Workshop, a beaker
// at the Test Lab, flipping pages in the Archives. Pure functions of time that write into a
// caller-owned pose, so a frame allocates nothing.

export type WorkArea = "workshop" | "testLab" | "archives";
export type Prop = "none" | "hammer" | "beaker" | "pages";

export interface Pose {
  /** Arm swing about the shoulder, radians. Zero is hanging straight down. */
  rightArm: number;
  leftArm: number;
  /** Small vertical bob of the whole body, world units before scaling. */
  bob: number;
  prop: Prop;
}

/** Seconds per loop. */
export const LOOP_SECONDS = 1.2;

const TAU = Math.PI * 2;

export function createPose(): Pose {
  return { rightArm: 0, leftArm: 0, bob: 0, prop: "none" };
}

export function areaFor(activity: ActivityView): WorkArea | undefined {
  switch (activity) {
    case "implementing":
      return "workshop";
    case "testing":
      return "testLab";
    case "researching":
    case "documenting":
      return "archives";
    default:
      return undefined;
  }
}

/** Fills `out` with the pose at `seconds` and returns it. */
export function workPose(area: WorkArea | undefined, seconds: number, out: Pose): Pose {
  const phase = (seconds / LOOP_SECONDS) * TAU;
  switch (area) {
    case "workshop": {
      // Raise the hammer, strike, recover; the left arm steadies the work.
      const swing = Math.sin(phase);
      out.rightArm = -1.3 - 0.9 * swing;
      out.leftArm = -0.5;
      out.bob = 0.02 * Math.max(0, -swing);
      out.prop = "hammer";
      return out;
    }
    case "testLab": {
      // Tilt the beaker out and back.
      out.rightArm = -1.2 + 0.35 * Math.sin(phase);
      out.leftArm = -0.4;
      out.bob = 0;
      out.prop = "beaker";
      return out;
    }
    case "archives": {
      // Hold the pages and flip with the other hand.
      out.rightArm = -1.0;
      out.leftArm = -0.9 + 0.5 * Math.max(0, Math.sin(phase));
      out.bob = 0;
      out.prop = "pages";
      return out;
    }
    default:
      out.rightArm = 0;
      out.leftArm = 0;
      out.bob = 0;
      out.prop = "none";
      return out;
  }
}
