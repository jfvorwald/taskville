import type {
  AreaId,
  CityLayout,
  Footprint,
  Lamp,
  NavEdge,
  NavNode,
  StreetLine,
  Tree,
  WorkAreaLayout,
  WorkstationSlot,
} from "./types.ts";

// The city is a 3 x 3 grid of 10 m cells. The center cell is the plaza, the six work areas
// take the other cells except the north and south middles, which stay open (trees). Streets run
// on the cell borders, so every building has a street on every side.
const CELL = 10;
const STREET_WIDTH = 2;
const STREET_LINES = [-1.5, -0.5, 0.5, 1.5].map((n) => n * CELL);
const STREET_STEP = CELL / 2;
const HALF_GROUND = 17;
const PLAZA_HALF = 3.5;
const SLOT_COUNT = 4;
const SLOT_SPACING = 1.2;
const SLOT_OFFSET = 0.9;

interface AreaSpec {
  id: AreaId;
  name: string;
  col: -1 | 0 | 1;
  row: -1 | 0 | 1;
  halfX: number;
  halfZ: number;
  height: number;
}

const AREA_SPECS: AreaSpec[] = [
  { id: "dispatch", name: "Dispatch", col: -1, row: -1, halfX: 2.4, halfZ: 2.4, height: 5.6 },
  { id: "workshop", name: "Workshop", col: 1, row: -1, halfX: 2.8, halfZ: 2.4, height: 3.2 },
  { id: "test_lab", name: "Test Lab", col: 1, row: 0, halfX: 2.4, halfZ: 2.4, height: 3.8 },
  { id: "review", name: "Review", col: 1, row: 1, halfX: 2.6, halfZ: 2.6, height: 4.6 },
  { id: "security", name: "Security", col: -1, row: 1, halfX: 2.4, halfZ: 2.8, height: 3.4 },
  { id: "archives", name: "Archives", col: -1, row: 0, halfX: 3.0, halfZ: 2.2, height: 2.6 },
];

const streetId = (x: number, z: number) => `st:${x}:${z}`;
const onLine = (v: number) => STREET_LINES.includes(v);

function streetCoords(): number[] {
  const out: number[] = [];
  const max = STREET_LINES[STREET_LINES.length - 1] ?? 0;
  for (let v = -max; v <= max; v += STREET_STEP) out.push(v);
  return out;
}

function buildStreets(): StreetLine[] {
  const max = STREET_LINES[STREET_LINES.length - 1] ?? 0;
  const lines: StreetLine[] = [];
  for (const at of STREET_LINES) {
    lines.push({ axis: "x", at, from: -max, to: max, width: STREET_WIDTH });
    lines.push({ axis: "z", at, from: -max, to: max, width: STREET_WIDTH });
  }
  return lines;
}

function dist(a: { x: number; z: number }, b: { x: number; z: number }): number {
  return Math.hypot(a.x - b.x, a.z - b.z);
}

/** Builds the city layout. Pure and deterministic; `CITY_LAYOUT` is the one instance to use. */
export function buildCityLayout(): CityLayout {
  const nodes: NavNode[] = [];
  const edges: NavEdge[] = [];
  const nodeIndex = new Map<string, NavNode>();
  const addNode = (node: NavNode) => {
    nodes.push(node);
    nodeIndex.set(node.id, node);
  };
  const addEdge = (from: string, to: string) => {
    const a = nodeIndex.get(from);
    const b = nodeIndex.get(to);
    if (!a || !b) throw new Error(`edge references a missing node: ${from} - ${to}`);
    edges.push({ from, to, length: dist(a, b) });
  };

  // Street lattice: nodes every STREET_STEP along every street line, edges between neighbors.
  const coords = streetCoords();
  for (const x of coords) {
    for (const z of coords) {
      if (!onLine(x) && !onLine(z)) continue;
      addNode({ id: streetId(x, z), x, z, kind: onLine(x) && onLine(z) ? "junction" : "street" });
    }
  }
  for (const x of coords) {
    for (const z of coords) {
      if (!nodeIndex.has(streetId(x, z))) continue;
      if (onLine(x) && nodeIndex.has(streetId(x, z + STREET_STEP)))
        addEdge(streetId(x, z), streetId(x, z + STREET_STEP));
      if (onLine(z) && nodeIndex.has(streetId(x + STREET_STEP, z)))
        addEdge(streetId(x, z), streetId(x + STREET_STEP, z));
    }
  }

  // Plaza: a center node and four doors, each joined to the street midpoint beside it.
  const plazaNodeId = "plaza:center";
  addNode({ id: plazaNodeId, x: 0, z: 0, kind: "plaza" });
  const doors: Array<[string, number, number, number, number]> = [
    ["n", 0, -PLAZA_HALF, 0, -STREET_STEP],
    ["s", 0, PLAZA_HALF, 0, STREET_STEP],
    ["w", -PLAZA_HALF, 0, -STREET_STEP, 0],
    ["e", PLAZA_HALF, 0, STREET_STEP, 0],
  ];
  for (const [name, x, z, sx, sz] of doors) {
    addNode({ id: `plaza:${name}`, x, z, kind: "plaza" });
    addEdge(`plaza:${name}`, plazaNodeId);
    addEdge(`plaza:${name}`, streetId(sx, sz));
  }

  // Work areas and their slots.
  const areas: WorkAreaLayout[] = [];
  const slots: WorkstationSlot[] = [];
  for (const spec of AREA_SPECS) {
    const footprint: Footprint = {
      cx: spec.col * CELL,
      cz: spec.row * CELL,
      halfX: spec.halfX,
      halfZ: spec.halfZ,
    };
    const anchorId = streetId(footprint.cx, footprint.cz + STREET_STEP);
    if (!nodeIndex.has(anchorId)) throw new Error(`no street anchor for ${spec.id}`);
    const slotIds: string[] = [];
    for (let i = 0; i < SLOT_COUNT; i++) {
      const x = footprint.cx + (i - (SLOT_COUNT - 1) / 2) * SLOT_SPACING;
      const z = footprint.cz + footprint.halfZ + SLOT_OFFSET;
      const id = `${spec.id}:${i}`;
      const nodeId = `slot:${id}`;
      addNode({ id: nodeId, x, z, kind: "slot" });
      addEdge(nodeId, anchorId);
      slots.push({
        id,
        areaId: spec.id,
        index: i,
        x,
        z,
        facing: Math.atan2(footprint.cx - x, footprint.cz - z),
        nodeId,
        anchorId,
      });
      slotIds.push(id);
    }
    areas.push({
      id: spec.id,
      name: spec.name,
      footprint,
      height: spec.height,
      anchorId,
      slotIds,
    });
  }

  // Scenery: a lamp at the front corners of every cell and the plaza corners; a tree at the
  // outer back corner of every cell and in the two open cells.
  const lamps: Lamp[] = [];
  const trees: Tree[] = [];
  for (const a of areas) {
    for (const sx of [-1, 1]) lamps.push({ x: a.footprint.cx + sx * 3.6, z: a.footprint.cz + 3.6 });
    trees.push({
      x: a.footprint.cx + Math.sign(a.footprint.cx) * 3.4,
      z: a.footprint.cz - 3.4,
      scale: 1,
    });
  }
  for (const sx of [-1, 1]) {
    for (const sz of [-1, 1]) lamps.push({ x: sx * PLAZA_HALF, z: sz * PLAZA_HALF });
  }
  for (const z of [-CELL, CELL]) {
    trees.push({ x: -1.6, z: z - 0.8, scale: 1.2 });
    trees.push({ x: 1.4, z: z + 1.2, scale: 0.9 });
    trees.push({ x: 2.4, z: z - 1.6, scale: 1.1 });
  }

  const half = HALF_GROUND;
  return {
    bounds: { minX: -half, maxX: half, minZ: -half, maxZ: half },
    plaza: { cx: 0, cz: 0, half: PLAZA_HALF },
    plazaNodeId,
    areas,
    streets: buildStreets(),
    graph: { nodes, edges },
    slots,
    props: { lamps, trees },
  };
}

export const CITY_LAYOUT: CityLayout = buildCityLayout();
