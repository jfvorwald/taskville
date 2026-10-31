import { describe, expect, it } from "vitest";
import { buildingParts, windowSites } from "../../../src/city/buildings/parts.ts";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";

describe("procedural building parts", () => {
  it("builds a body and a roof for every work area", () => {
    for (const area of CITY_LAYOUT.areas) {
      const parts = buildingParts(area);
      expect(parts.filter((p) => p.role === "body").length, area.id).toBe(1);
      expect(parts.filter((p) => p.role === "roof").length, area.id).toBe(1);
    }
  });

  it("body fills the footprint at the area height", () => {
    for (const area of CITY_LAYOUT.areas) {
      const body = buildingParts(area).find((p) => p.role === "body");
      expect(body?.size.x, area.id).toBeCloseTo(area.footprint.halfX * 2, 6);
      expect(body?.size.z, area.id).toBeCloseTo(area.footprint.halfZ * 2, 6);
      expect((body?.position.y ?? 0) + (body?.size.y ?? 0) / 2, area.id).toBeCloseTo(
        area.height,
        6,
      );
    }
  });

  it("keeps every part within the footprint horizontally and above the ground", () => {
    for (const area of CITY_LAYOUT.areas) {
      const f = area.footprint;
      for (const p of buildingParts(area)) {
        expect(p.position.x - p.size.x / 2, `${area.id} ${p.role}`).toBeGreaterThanOrEqual(
          f.cx - f.halfX - 1e-6,
        );
        expect(p.position.x + p.size.x / 2).toBeLessThanOrEqual(f.cx + f.halfX + 1e-6);
        expect(p.position.z - p.size.z / 2).toBeGreaterThanOrEqual(f.cz - f.halfZ - 1e-6);
        expect(p.position.z + p.size.z / 2).toBeLessThanOrEqual(f.cz + f.halfZ + 1e-6);
        expect(p.position.y - p.size.y / 2).toBeGreaterThanOrEqual(-1e-6);
      }
    }
  });

  it("gives each area its own silhouette: no two areas share the same set of part sizes", () => {
    const sig = CITY_LAYOUT.areas.map((a) =>
      buildingParts(a)
        .map(
          (p) => `${p.role}:${p.size.x.toFixed(2)}x${p.size.y.toFixed(2)}x${p.size.z.toFixed(2)}`,
        )
        .join(","),
    );
    expect(new Set(sig).size).toBe(sig.length);
  });
});

describe("window sites (instanced across all buildings)", () => {
  it("puts every window on a building face, facing out, within the wall", () => {
    const sites = windowSites(CITY_LAYOUT);
    expect(sites.length).toBeGreaterThan(CITY_LAYOUT.areas.length * 4);
    for (const w of sites) {
      const area = CITY_LAYOUT.areas.find((a) => a.id === w.areaId);
      expect(area).toBeDefined();
      if (!area) continue;
      const f = area.footprint;
      expect(w.y).toBeGreaterThan(0);
      expect(w.y).toBeLessThan(area.height);
      const onX = Math.abs(Math.abs(w.x - f.cx) - f.halfX) < 0.1;
      const onZ = Math.abs(Math.abs(w.z - f.cz) - f.halfZ) < 0.1;
      expect(onX || onZ, `${w.areaId} window on a face`).toBe(true);
      expect([0, Math.PI / 2, Math.PI, -Math.PI / 2]).toContain(w.yaw);
    }
  });

  it("only puts windows on the two camera-facing walls (south and east)", () => {
    for (const w of windowSites(CITY_LAYOUT)) {
      expect([0, Math.PI / 2]).toContain(w.yaw);
    }
  });

  it("does not put a window on a wall where a slot stands in front of a door", () => {
    // Doors are on the south wall at the slot side; windows keep clear of the door strip.
    for (const area of CITY_LAYOUT.areas) {
      const door = buildingParts(area).find((p) => p.role === "door");
      expect(door, area.id).toBeDefined();
      if (!door) continue;
      for (const w of windowSites(CITY_LAYOUT).filter((s) => s.areaId === area.id)) {
        const overlaps =
          Math.abs(w.z - door.position.z) < 0.2 && Math.abs(w.x - door.position.x) < door.size.x;
        expect(overlaps, `${area.id} window over door`).toBe(false);
      }
    }
  });
});
