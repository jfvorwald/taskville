import { describe, expect, it } from "vitest";
import {
  CITY_LAYOUT,
  type Footprint,
  findPath,
  nodeById,
  reachableFrom,
} from "../../../src/city/layout/index.ts";

const L = CITY_LAYOUT;
const { nodes, edges } = L.graph;

/** Does the segment a-b pass through the open rectangle of f? (Liang-Barsky clip.) */
function segmentCrosses(
  a: { x: number; z: number },
  b: { x: number; z: number },
  f: Footprint,
): boolean {
  let t0 = 0;
  let t1 = 1;
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const checks: Array<[number, number]> = [
    [-dx, a.x - (f.cx - f.halfX)],
    [dx, f.cx + f.halfX - a.x],
    [-dz, a.z - (f.cz - f.halfZ)],
    [dz, f.cz + f.halfZ - a.z],
  ];
  for (const [p, q] of checks) {
    if (p === 0) {
      if (q <= 0) return false;
    } else {
      const r = q / p;
      if (p < 0) {
        if (r > t1) return false;
        t0 = Math.max(t0, r);
      } else {
        if (r < t0) return false;
        t1 = Math.min(t1, r);
      }
    }
  }
  return t1 - t0 > 1e-6;
}

describe("street graph structure", () => {
  it("has unique node ids and edges that reference existing nodes", () => {
    expect(new Set(nodes.map((n) => n.id)).size).toBe(nodes.length);
    for (const e of edges) {
      expect(nodeById(L, e.from), e.from).toBeDefined();
      expect(nodeById(L, e.to), e.to).toBeDefined();
      expect(e.from).not.toBe(e.to);
      expect(e.length).toBeGreaterThan(0);
    }
  });

  it("stores each undirected edge once, with its true length", () => {
    const keys = new Set<string>();
    for (const e of edges) {
      const key = [e.from, e.to].sort().join("|");
      expect(keys.has(key), key).toBe(false);
      keys.add(key);
      const a = nodeById(L, e.from);
      const b = nodeById(L, e.to);
      if (!a || !b) throw new Error("missing node");
      expect(e.length).toBeCloseTo(Math.hypot(a.x - b.x, a.z - b.z), 6);
    }
  });

  it("keeps every node inside the ground bounds and outside every building", () => {
    for (const n of nodes) {
      expect(n.x).toBeGreaterThanOrEqual(L.bounds.minX);
      expect(n.x).toBeLessThanOrEqual(L.bounds.maxX);
      expect(n.z).toBeGreaterThanOrEqual(L.bounds.minZ);
      expect(n.z).toBeLessThanOrEqual(L.bounds.maxZ);
      for (const area of L.areas) {
        const f = area.footprint;
        const inFootprint = Math.abs(n.x - f.cx) < f.halfX && Math.abs(n.z - f.cz) < f.halfZ;
        expect(inFootprint, `${n.id} in ${area.id}`).toBe(false);
      }
    }
  });

  it("never routes an edge through a building", () => {
    for (const e of edges) {
      const a = nodeById(L, e.from);
      const b = nodeById(L, e.to);
      if (!a || !b) throw new Error("missing node");
      for (const area of L.areas) {
        expect(segmentCrosses(a, b, area.footprint), `${e.from}-${e.to} through ${area.id}`).toBe(
          false,
        );
      }
    }
  });

  it("has a plaza node at the plaza center", () => {
    const plaza = nodes.filter((n) => n.kind === "plaza");
    expect(plaza.length).toBeGreaterThan(0);
    const center = nodeById(L, L.plazaNodeId);
    expect(center?.x).toBe(L.plaza.cx);
    expect(center?.z).toBe(L.plaza.cz);
  });
});

describe("street graph connectivity", () => {
  it("is one connected component", () => {
    const seen = reachableFrom(L, L.plazaNodeId);
    expect(seen.size).toBe(nodes.length);
  });

  it("makes every workstation slot reachable from the plaza and from every other slot", () => {
    const fromPlaza = reachableFrom(L, L.plazaNodeId);
    for (const slot of L.slots) {
      expect(fromPlaza.has(slot.nodeId), slot.id).toBe(true);
      expect(nodeById(L, slot.nodeId)?.kind, slot.id).toBe("slot");
    }
    for (const a of L.slots) {
      for (const b of L.slots) {
        if (a === b) continue;
        expect(findPath(L, a.nodeId, b.nodeId), `${a.id} -> ${b.id}`).not.toBeNull();
      }
    }
  });

  it("gives every work area an anchor on the street its slots face", () => {
    for (const slot of L.slots) {
      const anchor = nodeById(L, slot.anchorId);
      expect(anchor, slot.id).toBeDefined();
      expect(anchor?.kind).not.toBe("slot");
      const link = edges.find(
        (e) =>
          (e.from === slot.nodeId && e.to === slot.anchorId) ||
          (e.to === slot.nodeId && e.from === slot.anchorId),
      );
      expect(link, `${slot.id} spur`).toBeDefined();
    }
  });

  it("reaches the plaza from every area anchor", () => {
    for (const area of L.areas) {
      expect(area.anchorId).toBeDefined();
      expect(findPath(L, area.anchorId, L.plazaNodeId), area.id).not.toBeNull();
    }
  });
});

describe("findPath", () => {
  it("returns a contiguous path whose length is at least the straight-line distance", () => {
    const a = L.slots[0];
    const b = L.slots[L.slots.length - 1];
    if (!a || !b) throw new Error("no slots");
    const path = findPath(L, a.nodeId, b.nodeId);
    expect(path).not.toBeNull();
    if (!path) return;
    expect(path.nodeIds[0]).toBe(a.nodeId);
    expect(path.nodeIds[path.nodeIds.length - 1]).toBe(b.nodeId);
    let total = 0;
    for (let i = 1; i < path.nodeIds.length; i++) {
      const from = path.nodeIds[i - 1];
      const to = path.nodeIds[i];
      const e = edges.find(
        (x) => (x.from === from && x.to === to) || (x.from === to && x.to === from),
      );
      expect(e, `${from}-${to}`).toBeDefined();
      total += e?.length ?? 0;
    }
    expect(path.length).toBeCloseTo(total, 6);
    expect(path.length).toBeGreaterThanOrEqual(Math.hypot(a.x - b.x, a.z - b.z) - 1e-6);
  });

  it("is a zero-length path to itself and null for unknown ids", () => {
    const id = L.plazaNodeId;
    expect(findPath(L, id, id)).toEqual({ nodeIds: [id], length: 0 });
    expect(findPath(L, id, "nope")).toBeNull();
    expect(findPath(L, "nope", id)).toBeNull();
  });

  it("takes the shorter of two routes", () => {
    const a = L.slots.find((s) => s.areaId === "dispatch");
    const b = L.slots.find((s) => s.areaId === "workshop");
    if (!a || !b) throw new Error("missing slots");
    const path = findPath(L, a.nodeId, b.nodeId);
    const back = findPath(L, b.nodeId, a.nodeId);
    expect(path?.length).toBeCloseTo(back?.length ?? -1, 6);
  });
});
