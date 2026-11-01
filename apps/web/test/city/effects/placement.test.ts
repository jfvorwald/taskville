import { describe, expect, it } from "vitest";
import { buildingParts } from "../../../src/city/buildings/parts.ts";
import {
  SPARKLE_CLEARANCE,
  SPARKLE_RADIUS,
  sparkleAnchor,
} from "../../../src/city/effects/placement.ts";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";

// M3.13 (roborev 5518 medium 2): with reduced motion the sparkle icon for a test result sat at
// roof top + 1, inside the Test Lab's opaque rooftop glass cube (it spans top to top + 1.2), so it
// was hidden. `sparkleAnchor(areaId)` is the world position of the sparkle billboard's centre for a
// building; the star is a camera-facing billboard whose extent is `SPARKLE_RADIUS` in every
// direction (the 8-point star in Celebrations.tsx has outer radius 0.35).
//
// Contract: the whole billboard (centre minus SPARKLE_RADIUS) clears the tallest part of the
// building by at least SPARKLE_CLEARANCE, and the anchor sits over the building's footprint.

const top = (area: (typeof CITY_LAYOUT.areas)[number]): number =>
  Math.max(...buildingParts(area).map((p) => p.position.y + p.size.y / 2));

describe("sparkle placement", () => {
  it("states the billboard radius and a clearance of at least 0.1 m", () => {
    expect(SPARKLE_RADIUS).toBeCloseTo(0.35, 5);
    expect(SPARKLE_CLEARANCE).toBeGreaterThanOrEqual(0.1);
  });

  it.each(CITY_LAYOUT.areas.map((a) => [a.id, a] as const))(
    "%s: the whole sparkle clears the tallest rooftop part",
    (id, area) => {
      const at = sparkleAnchor(id);
      expect(at.y - SPARKLE_RADIUS).toBeGreaterThanOrEqual(top(area) + SPARKLE_CLEARANCE);
    },
  );

  it.each(CITY_LAYOUT.areas.map((a) => [a.id, a] as const))(
    "%s: the sparkle is over the building, not floating beside it",
    (id, area) => {
      const at = sparkleAnchor(id);
      const { cx, cz, halfX, halfZ } = area.footprint;
      expect(Math.abs(at.x - cx)).toBeLessThanOrEqual(halfX);
      expect(Math.abs(at.z - cz)).toBeLessThanOrEqual(halfZ);
    },
  );

  it("the Test Lab sparkle is above its glass cube (the regression)", () => {
    const lab = CITY_LAYOUT.areas.find((a) => a.id === "test_lab");
    if (lab === undefined) throw new Error("no test_lab area");
    const glassTop = Math.max(
      ...buildingParts(lab)
        .filter((p) => p.tone === "glass")
        .map((p) => p.position.y + p.size.y / 2),
    );
    expect(sparkleAnchor("test_lab").y - SPARKLE_RADIUS).toBeGreaterThan(glassTop);
  });
});
