import { buildingParts } from "../buildings/parts.ts";
import { type AreaId, CITY_LAYOUT } from "../layout/index.ts";

/** Outer radius of the sparkle star; the star geometry in Celebrations.tsx is built from this. */
export const SPARKLE_RADIUS = 0.35;

/** Gap between the lowest point of the sparkle and the tallest rooftop part. */
export const SPARKLE_CLEARANCE = 0.3;

/**
 * World position of the sparkle billboard's centre for an area: over the footprint centre, with the
 * whole star above the tallest part of the building (rooftop features such as the Test Lab's glass
 * cube included).
 */
export function sparkleAnchor(areaId: AreaId): { x: number; y: number; z: number } {
  const area = CITY_LAYOUT.areas.find((a) => a.id === areaId);
  if (area === undefined) throw new Error(`unknown area ${areaId}`);
  const top = Math.max(...buildingParts(area).map((p) => p.position.y + p.size.y / 2));
  return {
    x: area.footprint.cx,
    y: top + SPARKLE_CLEARANCE + SPARKLE_RADIUS,
    z: area.footprint.cz,
  };
}
