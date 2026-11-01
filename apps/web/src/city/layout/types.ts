/**
 * City layout types. The layout is plain data: no React, no three.js. World units are meters:
 * x runs east, z runs south, y is up, and the ground top is y = 0. M3.05 (agents) and M3.06
 * (navigation) read `CITY_LAYOUT` and `findPath` from `./index.ts`; nothing else in this folder
 * is meant to be depended on.
 */

/** The six work areas. Same ids as the engine's `WORK_AREAS` (a test guards against drift). */
export const AREA_IDS = [
  "dispatch",
  "workshop",
  "test_lab",
  "review",
  "security",
  "archives",
] as const;
export type AreaId = (typeof AREA_IDS)[number];

/** An axis-aligned rectangle on the ground: center plus half extents. */
export interface Footprint {
  cx: number;
  cz: number;
  halfX: number;
  halfZ: number;
}

export interface Bounds {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

export interface WorkAreaLayout {
  id: AreaId;
  /** Display name ("Test Lab"). */
  name: string;
  footprint: Footprint;
  /** Wall height of the main body in meters; roofs and features sit on top of it. */
  height: number;
  /** Street node outside the building's front (south) side; the area's navigation anchor. */
  anchorId: string;
  /** The area's workstation slots, in left-to-right order along the front. */
  slotIds: string[];
}

/** A straight street. `axis: "x"` is a street at constant x running along z, and vice versa. */
export interface StreetLine {
  axis: "x" | "z";
  /** The constant coordinate of the street centerline. */
  at: number;
  /** Extent along the other axis. */
  from: number;
  to: number;
  width: number;
}

export interface Plaza {
  cx: number;
  cz: number;
  /** Half the side length; the plaza is a square. */
  half: number;
}

/**
 * A node in the street graph. `junction` is a street crossing, `street` a point along a street,
 * `plaza` is the plaza center or one of its four edge doors, and `slot` is a workstation slot.
 * Plaza nodes are the safe waiting points (ARCHITECTURE.md 11, needs-you agents).
 */
export type NavNodeKind = "junction" | "street" | "plaza" | "slot";

export interface NavNode {
  id: string;
  x: number;
  z: number;
  kind: NavNodeKind;
}

/** An undirected edge; stored once. */
export interface NavEdge {
  from: string;
  to: string;
  length: number;
}

export interface StreetGraph {
  nodes: NavNode[];
  edges: NavEdge[];
}

/**
 * A fixed standing place outside a building. Reserved by M3.05/M3.06, one agent at a time.
 * `nodeId` is the slot's own graph node (kind "slot"); `anchorId` is the street node it hangs
 * off. `facing` is a yaw in radians such that (sin, cos) points from the slot toward the building.
 */
export interface WorkstationSlot {
  id: string;
  areaId: AreaId;
  index: number;
  x: number;
  z: number;
  facing: number;
  nodeId: string;
  anchorId: string;
}

export interface Lamp {
  x: number;
  z: number;
}

export interface Tree {
  x: number;
  z: number;
  scale: number;
}

export interface CityLayout {
  /** Ground slab extent. Everything lies inside it. */
  bounds: Bounds;
  plaza: Plaza;
  /** Graph node at the plaza center; the default starting point and a safe stop. */
  plazaNodeId: string;
  areas: WorkAreaLayout[];
  streets: StreetLine[];
  graph: StreetGraph;
  slots: WorkstationSlot[];
  props: { lamps: Lamp[]; trees: Tree[] };
}
