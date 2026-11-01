import { describe, expect, it } from "vitest";
import { WORK_AREAS } from "../../../../engine/src/config/config.ts";
import { AREA_IDS, CITY_LAYOUT, type Footprint } from "../../../src/city/layout/index.ts";

const L = CITY_LAYOUT;

function overlap(a: Footprint, b: Footprint, gap = 0): boolean {
  return (
    Math.abs(a.cx - b.cx) < a.halfX + b.halfX + gap &&
    Math.abs(a.cz - b.cz) < a.halfZ + b.halfZ + gap
  );
}

function inside(p: { x: number; z: number }, f: Footprint, margin = 0): boolean {
  return Math.abs(p.x - f.cx) < f.halfX + margin && Math.abs(p.z - f.cz) < f.halfZ + margin;
}

describe("city layout: work areas", () => {
  it("has exactly the six engine work areas, once each, in a stable order", () => {
    expect([...AREA_IDS]).toEqual([...WORK_AREAS]);
    expect(L.areas.map((a) => a.id)).toEqual([...WORK_AREAS]);
  });

  it("is deterministic data: building it twice gives equal values", async () => {
    const { buildCityLayout } = await import("../../../src/city/layout/index.ts");
    expect(buildCityLayout()).toEqual(L);
  });

  it("keeps every footprint within the ground bounds", () => {
    for (const area of L.areas) {
      const f = area.footprint;
      expect(f.cx - f.halfX, area.id).toBeGreaterThanOrEqual(L.bounds.minX);
      expect(f.cx + f.halfX, area.id).toBeLessThanOrEqual(L.bounds.maxX);
      expect(f.cz - f.halfZ, area.id).toBeGreaterThanOrEqual(L.bounds.minZ);
      expect(f.cz + f.halfZ, area.id).toBeLessThanOrEqual(L.bounds.maxZ);
      expect(area.height, area.id).toBeGreaterThan(0);
    }
  });

  it("keeps footprints apart from each other, the plaza and every street", () => {
    for (const [i, a] of L.areas.entries()) {
      for (const b of L.areas.slice(i + 1)) {
        expect(overlap(a.footprint, b.footprint, 1), `${a.id} vs ${b.id}`).toBe(false);
      }
      const plaza: Footprint = {
        cx: L.plaza.cx,
        cz: L.plaza.cz,
        halfX: L.plaza.half,
        halfZ: L.plaza.half,
      };
      expect(overlap(a.footprint, plaza), `${a.id} vs plaza`).toBe(false);
      for (const s of L.streets) {
        const f = a.footprint;
        const [lo, hi] =
          s.axis === "x" ? [f.cx - f.halfX, f.cx + f.halfX] : [f.cz - f.halfZ, f.cz + f.halfZ];
        expect(lo >= s.at + s.width / 2 || hi <= s.at - s.width / 2, `${a.id} vs street`).toBe(
          true,
        );
      }
    }
  });

  it("keeps the plaza and the streets within the ground bounds", () => {
    expect(L.plaza.cx - L.plaza.half).toBeGreaterThanOrEqual(L.bounds.minX);
    expect(L.plaza.cx + L.plaza.half).toBeLessThanOrEqual(L.bounds.maxX);
    expect(L.plaza.cz - L.plaza.half).toBeGreaterThanOrEqual(L.bounds.minZ);
    expect(L.plaza.cz + L.plaza.half).toBeLessThanOrEqual(L.bounds.maxZ);
    for (const s of L.streets) {
      expect(s.at - s.width / 2).toBeGreaterThanOrEqual(
        s.axis === "x" ? L.bounds.minX : L.bounds.minZ,
      );
      expect(s.at + s.width / 2).toBeLessThanOrEqual(
        s.axis === "x" ? L.bounds.maxX : L.bounds.maxZ,
      );
    }
  });
});

describe("city layout: workstation slots", () => {
  it("gives every work area at least three slots, listed on the area", () => {
    for (const area of L.areas) {
      const slots = L.slots.filter((s) => s.areaId === area.id);
      expect(slots.length, area.id).toBeGreaterThanOrEqual(3);
      expect(area.slotIds, area.id).toEqual(slots.map((s) => s.id));
    }
  });

  it("has unique ids and puts every slot outside every building, within bounds", () => {
    expect(new Set(L.slots.map((s) => s.id)).size).toBe(L.slots.length);
    for (const slot of L.slots) {
      expect(slot.x).toBeGreaterThan(L.bounds.minX);
      expect(slot.x).toBeLessThan(L.bounds.maxX);
      expect(slot.z).toBeGreaterThan(L.bounds.minZ);
      expect(slot.z).toBeLessThan(L.bounds.maxZ);
      for (const area of L.areas) {
        expect(inside(slot, area.footprint), `${slot.id} in ${area.id}`).toBe(false);
      }
    }
  });

  it("keeps slots of one area apart so standing agents never overlap", () => {
    for (const a of L.slots) {
      for (const b of L.slots) {
        if (a.id >= b.id) continue;
        expect(Math.hypot(a.x - b.x, a.z - b.z), `${a.id} / ${b.id}`).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("places each slot just outside its own building, facing it", () => {
    for (const slot of L.slots) {
      const area = L.areas.find((a) => a.id === slot.areaId);
      expect(area).toBeDefined();
      if (!area) continue;
      const f = area.footprint;
      const dx = Math.max(Math.abs(slot.x - f.cx) - f.halfX, 0);
      const dz = Math.max(Math.abs(slot.z - f.cz) - f.halfZ, 0);
      expect(Math.hypot(dx, dz), slot.id).toBeLessThanOrEqual(1.5);
      // facing is a yaw in radians; (sin, cos) points from the slot toward the building.
      const toward = { x: Math.sin(slot.facing), z: Math.cos(slot.facing) };
      const toCenter = { x: f.cx - slot.x, z: f.cz - slot.z };
      expect(toward.x * toCenter.x + toward.z * toCenter.z, slot.id).toBeGreaterThan(0);
    }
  });
});

describe("city layout: scenery", () => {
  it("keeps lamps and trees inside the bounds and clear of footprints and slots", () => {
    expect(L.props.lamps.length).toBeGreaterThan(0);
    expect(L.props.trees.length).toBeGreaterThan(0);
    for (const p of [...L.props.lamps, ...L.props.trees]) {
      expect(p.x).toBeGreaterThanOrEqual(L.bounds.minX);
      expect(p.x).toBeLessThanOrEqual(L.bounds.maxX);
      expect(p.z).toBeGreaterThanOrEqual(L.bounds.minZ);
      expect(p.z).toBeLessThanOrEqual(L.bounds.maxZ);
      for (const area of L.areas) {
        expect(inside(p, area.footprint, 0.3), `prop in ${area.id}`).toBe(false);
      }
      for (const slot of L.slots) {
        expect(Math.hypot(p.x - slot.x, p.z - slot.z), slot.id).toBeGreaterThan(0.6);
      }
    }
  });
});
