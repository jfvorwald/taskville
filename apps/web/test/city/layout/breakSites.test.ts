import { describe, expect, it } from "vitest";
import {
  type BreakSite,
  buildCityLayout,
  CITY_LAYOUT,
  type Footprint,
  findPath,
} from "../../../src/city/layout/index.ts";
import { validateAccents } from "../../../src/themes/core/contract.ts";
import { THEMES } from "../../../src/themes/core/themes.ts";

// M9.02 assumed API: `layout.breakSites` is [bar, smoke]. Bar: north middle cell (center 0,-10),
// 4 spots and props = 1 counter + 4 stools. Smoke: south middle cell (center 0,10), 3 spots and
// props = 1 bench + 1 lamp. Spots are graph nodes of kind "break" with id `break:<site>:<index>`
// (spot.nodeId). Break props are NOT repeated in `layout.props.lamps`/`trees`.

const L = CITY_LAYOUT;
const STREET_HALF = 1;
const SPOT_CLEARANCE = 0.4;
const PROP_GAP = 0.2;

const site = (id: string): BreakSite => {
  const s = L.breakSites.find((x) => x.id === id);
  if (!s) throw new Error(`no break site ${id}`);
  return s;
};
const propFootprint = (p: { x: number; z: number; halfX: number; halfZ: number }): Footprint => ({
  cx: p.x,
  cz: p.z,
  halfX: p.halfX,
  halfZ: p.halfZ,
});
const allSpots = () => L.breakSites.flatMap((s) => s.spots);
const allProps = () => L.breakSites.flatMap((s) => s.props);

/** Distance outside every street strip along the axis the street fixes (negative: inside). */
function streetGap(x: number, z: number, halfX = 0, halfZ = 0): number {
  let gap = Number.POSITIVE_INFINITY;
  for (const s of L.streets) {
    const c = s.axis === "x" ? x : z;
    const h = s.axis === "x" ? halfX : halfZ;
    gap = Math.min(gap, Math.abs(c - s.at) - STREET_HALF - h);
  }
  return gap;
}

describe("break sites: the bar and the smoke corner", () => {
  it("has exactly a bar then a smoke site", () => {
    expect(L.breakSites.map((s) => s.id)).toEqual(["bar", "smoke"]);
  });

  it("puts the bar in the north middle cell and the smoke corner in the south middle cell", () => {
    expect(site("bar").cell).toMatchObject({ cx: 0, cz: -10 });
    expect(site("smoke").cell).toMatchObject({ cx: 0, cz: 10 });
  });

  it("gives the bar 4 spots and the smoke corner 3", () => {
    expect(site("bar").spots).toHaveLength(4);
    expect(site("smoke").spots).toHaveLength(3);
  });

  it("makes every spot a nav node of kind break, at the spot position, inside its cell", () => {
    for (const s of L.breakSites) {
      for (const [i, spot] of s.spots.entries()) {
        expect(spot.siteId).toBe(s.id);
        expect(spot.index).toBe(i);
        const node = L.graph.nodes.find((n) => n.id === spot.nodeId);
        expect(node, spot.id).toBeDefined();
        expect(node?.kind, spot.id).toBe("break");
        expect(node?.x).toBe(spot.x);
        expect(node?.z).toBe(spot.z);
        expect(Math.abs(spot.x - s.cell.cx), spot.id).toBeLessThan(s.cell.halfX);
        expect(Math.abs(spot.z - s.cell.cz), spot.id).toBeLessThan(s.cell.halfZ);
      }
    }
    expect(L.graph.nodes.filter((n) => n.kind === "break")).toHaveLength(7);
    expect(new Set(allSpots().map((p) => p.id)).size).toBe(7);
  });

  it("gives the bar a counter with 4 stools and the smoke corner a bench and a lamp", () => {
    const kinds = (id: string) =>
      site(id)
        .props.map((p) => p.kind)
        .sort();
    expect(kinds("bar")).toEqual(["counter", "stool", "stool", "stool", "stool"]);
    expect(kinds("smoke")).toEqual(["bench", "lamp"]);
  });

  it("is deterministic data", () => {
    expect(buildCityLayout()).toEqual(L);
  });
});

describe("break sites: reachability", () => {
  const origins = [
    ...L.slots.map((s) => s.nodeId),
    ...L.graph.nodes.filter((n) => n.kind === "plaza").map((n) => n.id),
  ];

  it("has workstation and plaza origins to test", () => {
    expect(L.graph.nodes.filter((n) => n.kind === "break")).not.toHaveLength(0);
    expect(origins.length).toBeGreaterThanOrEqual(24 + 5);
  });

  it("reaches every break spot from every workstation slot and plaza node, and back", () => {
    for (const spot of allSpots()) {
      for (const from of origins) {
        const there = findPath(L, from, spot.nodeId);
        expect(there, `${from} -> ${spot.id}`).not.toBeNull();
        const back = findPath(L, spot.nodeId, from);
        expect(back, `${spot.id} -> ${from}`).not.toBeNull();
        expect(back?.length).toBeCloseTo(there?.length ?? Number.NaN, 6);
      }
    }
  });

  it("connects each spot to the street graph with a short edge", () => {
    for (const spot of allSpots()) {
      const edges = L.graph.edges.filter((e) => e.from === spot.nodeId || e.to === spot.nodeId);
      expect(edges.length, spot.id).toBeGreaterThanOrEqual(1);
      for (const e of edges) expect(e.length, spot.id).toBeLessThanOrEqual(6);
    }
  });
});

describe("break sites: navigation clearance", () => {
  it("keeps spots out of the street strips and apart from each other and other nodes", () => {
    for (const spot of allSpots()) {
      expect(streetGap(spot.x, spot.z), spot.id).toBeGreaterThanOrEqual(SPOT_CLEARANCE);
      for (const n of L.graph.nodes) {
        if (n.id === spot.nodeId) continue;
        // Spots may hang off a street or plaza anchor, but never sit on top of another node.
        expect(Math.hypot(n.x - spot.x, n.z - spot.z), `${spot.id} / ${n.id}`).toBeGreaterThan(0.6);
      }
    }
  });

  it("keeps spots clear of trees, lamps and every non-stool prop", () => {
    for (const spot of allSpots()) {
      for (const t of L.props.trees)
        expect(Math.hypot(t.x - spot.x, t.z - spot.z), `${spot.id} tree`).toBeGreaterThan(0.6);
      for (const l of L.props.lamps)
        expect(Math.hypot(l.x - spot.x, l.z - spot.z), `${spot.id} lamp`).toBeGreaterThan(0.6);
      for (const p of allProps()) {
        if (p.kind === "stool") continue;
        const dx = Math.abs(spot.x - p.x) - p.halfX;
        const dz = Math.abs(spot.z - p.z) - p.halfZ;
        expect(Math.max(dx, dz), `${spot.id} in ${p.kind}`).toBeGreaterThanOrEqual(0.2);
      }
    }
  });

  it("keeps every break prop inside its cell and out of the street strips", () => {
    for (const s of L.breakSites) {
      for (const p of s.props) {
        expect(Math.abs(p.x - s.cell.cx) + p.halfX, `${s.id} ${p.kind}`).toBeLessThanOrEqual(
          s.cell.halfX,
        );
        expect(Math.abs(p.z - s.cell.cz) + p.halfZ, `${s.id} ${p.kind}`).toBeLessThanOrEqual(
          s.cell.halfZ,
        );
        expect(streetGap(p.x, p.z, p.halfX, p.halfZ), `${s.id} ${p.kind}`).toBeGreaterThanOrEqual(
          PROP_GAP,
        );
      }
    }
  });

  it("keeps break props off nodes, trees, lamps and each other (trees may have moved)", () => {
    const props = allProps();
    for (const p of props) {
      const f = propFootprint(p);
      const near = (q: { x: number; z: number }, margin: number) =>
        Math.abs(q.x - f.cx) < f.halfX + margin && Math.abs(q.z - f.cz) < f.halfZ + margin;
      for (const n of L.graph.nodes) expect(near(n, 0.3), `${p.kind} / ${n.id}`).toBe(false);
      for (const t of L.props.trees) expect(near(t, 0.4), `${p.kind} / tree`).toBe(false);
      for (const l of L.props.lamps) expect(near(l, 0.3), `${p.kind} / lamp`).toBe(false);
    }
    for (const [i, a] of props.entries()) {
      for (const b of props.slice(i + 1)) {
        const hit =
          Math.abs(a.x - b.x) < a.halfX + b.halfX && Math.abs(a.z - b.z) < a.halfZ + b.halfZ;
        expect(hit, `${a.kind} / ${b.kind}`).toBe(false);
      }
    }
  });

  it("leaves every tree inside the bounds and clear of the streets", () => {
    for (const t of L.props.trees) {
      expect(t.x).toBeGreaterThanOrEqual(L.bounds.minX);
      expect(t.x).toBeLessThanOrEqual(L.bounds.maxX);
      expect(streetGap(t.x, t.z), "tree").toBeGreaterThanOrEqual(0);
    }
  });
});

describe("break sites: themes", () => {
  it("keeps accent validation passing for every theme", () => {
    expect(THEMES).toHaveLength(4);
    for (const theme of THEMES) expect(validateAccents(L, theme.accents), theme.id).toEqual([]);
  });
});
