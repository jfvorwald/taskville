// Where a family stands around its parent, in the parent's frame (+z is the front). The bots keep
// to an arc in front, each generation one step further out; the "+N crew" marker has its own
// spot to the side, so it never sits on a bot.

const ARC_STEP = 0.8;
const ARC_SLOTS = 7;
const FIRST_RADIUS = 1.5;
const GENERATION_STEP = 0.7;
const ROW_STEP = 0.55;

/** How far from the parent's centre a bot stands at the door, to hand over its cube. */
export const DOOR_RADIUS = 0.7;

export interface Spot {
  /** Radians from the front, around the vertical axis. */
  readonly angle: number;
  readonly radius: number;
}

/** The work spot of the `index`th bot of a family (0 first), at `generation`. */
export function workSpot(index: number, generation: number): Spot {
  return {
    angle: ((index % ARC_SLOTS) - Math.floor(ARC_SLOTS / 2)) * ARC_STEP,
    radius:
      FIRST_RADIUS +
      GENERATION_STEP * (Math.max(1, generation) - 1) +
      ROW_STEP * Math.floor(index / ARC_SLOTS),
  };
}

export const MARKER_SPOT: Spot = { angle: 2.4, radius: FIRST_RADIUS };
