import { subagentScale } from "./generation.ts";

// Where a family stands around its parent, in the parent's frame (+z is the front). The bots keep
// to an arc in front; the "+N crew" marker has its own spot to the side, so it never sits on a
// bot. Distances are for a full-size parent and shrink with `reach`, so the bots of a small
// parent stand close to it instead of among its neighbors.

const ARC_STEP = 0.8;
const ARC_SLOTS = 7;
const FIRST_RADIUS = 1.5;
const ROW_STEP = 0.55;

const DOOR_RADIUS = 0.7;

/** How far from the parent's centre a bot stands at the door, to hand over its cube. */
export function doorRadius(reach: number): number {
  return DOOR_RADIUS * reach;
}

/** The distance factor for a family whose parent is of `parentGeneration` (0: not a subagent). */
export function reachOf(parentGeneration: number): number {
  return parentGeneration < 1 ? 1 : subagentScale(parentGeneration);
}

export interface Spot {
  /** Radians from the front, around the vertical axis. */
  readonly angle: number;
  readonly radius: number;
}

/** The work spot of the `index`th bot of a family (0 first). */
export function workSpot(index: number, reach: number): Spot {
  return {
    angle: ((index % ARC_SLOTS) - Math.floor(ARC_SLOTS / 2)) * ARC_STEP,
    radius: (FIRST_RADIUS + ROW_STEP * Math.floor(index / ARC_SLOTS)) * reach,
  };
}

export function markerSpot(reach: number): Spot {
  return { angle: 2.4, radius: FIRST_RADIUS * reach };
}
