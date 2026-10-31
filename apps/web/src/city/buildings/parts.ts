import type { AreaId, CityLayout, WorkAreaLayout } from "../layout/index.ts";

/** Which shared material a part uses; the palette maps tones to colors. */
export type Tone = "wall" | "roof" | "accent" | "dark" | "glass" | "door";
export type PartRole = "body" | "roof" | "door" | "feature";

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** One axis-aligned box of a building: world position of its center, and its size. */
export interface BuildingPart {
  role: PartRole;
  tone: Tone;
  position: Vec3;
  size: Vec3;
}

const ROOF_THICKNESS = 0.25;
const DOOR = { w: 0.9, h: 1.4, d: 0.1 };

/**
 * The boxes that make one building: a body filling the footprint, a roof slab, a door on the
 * south (front) wall, and a few features that give each work area its silhouette. All parts lie
 * inside the footprint. Windows are separate (`windowSites`) because they are instanced.
 */
export function buildingParts(area: WorkAreaLayout): BuildingPart[] {
  const { cx, cz, halfX, halfZ } = area.footprint;
  const h = area.height;
  const roofY = h + ROOF_THICKNESS / 2;
  const top = h + ROOF_THICKNESS;
  const box = (
    role: PartRole,
    tone: Tone,
    x: number,
    y: number,
    z: number,
    sx: number,
    sy: number,
    sz: number,
  ): BuildingPart => ({
    role,
    tone,
    position: { x: cx + x, y, z: cz + z },
    size: { x: sx, y: sy, z: sz },
  });

  const parts: BuildingPart[] = [
    box("body", area.id === "security" ? "dark" : "wall", 0, h / 2, 0, halfX * 2, h, halfZ * 2),
    box("roof", "roof", 0, roofY, 0, halfX * 2, ROOF_THICKNESS, halfZ * 2),
    box("door", "door", 0, DOOR.h / 2, halfZ - DOOR.d / 2, DOOR.w, DOOR.h, DOOR.d),
    ...features(area.id, halfX, halfZ, top, box),
  ];
  return parts;
}

type Box = (
  role: PartRole,
  tone: Tone,
  x: number,
  y: number,
  z: number,
  sx: number,
  sy: number,
  sz: number,
) => BuildingPart;

function features(id: AreaId, halfX: number, halfZ: number, top: number, box: Box): BuildingPart[] {
  switch (id) {
    case "dispatch":
      // A radio mast and a small relay box.
      return [
        box("feature", "accent", 0.6, top + 1.2, -0.6, 0.2, 2.4, 0.2),
        box("feature", "dark", -0.7, top + 0.3, 0.4, 0.9, 0.6, 0.7),
      ];
    case "workshop":
      // A chimney and a low sawtooth annex.
      return [
        box("feature", "dark", halfX - 0.7, top + 0.9, -halfZ + 0.7, 0.6, 1.8, 0.6),
        box("feature", "accent", -0.8, top + 0.35, 0, 1.6, 0.7, halfZ * 1.4),
      ];
    case "test_lab":
      // A glass cube and a vent stack.
      return [
        box("feature", "glass", 0, top + 0.6, 0, 1.4, 1.2, 1.4),
        box("feature", "accent", -halfX + 0.6, top + 0.4, halfZ - 0.6, 0.4, 0.8, 0.4),
      ];
    case "review":
      // A stepped tower with a lantern.
      return [
        box("feature", "wall", 0, top + 0.7, 0, halfX * 1.1, 1.4, halfZ * 1.1),
        box("feature", "accent", 0, top + 1.55, 0, 0.8, 0.3, 0.8),
      ];
    case "security":
      // Two corner turrets.
      return [
        box("feature", "accent", -halfX + 0.5, top + 0.55, -halfZ + 0.5, 0.8, 1.1, 0.8),
        box("feature", "accent", halfX - 0.5, top + 0.55, -halfZ + 0.5, 0.8, 1.1, 0.8),
      ];
    case "archives":
      // Front columns under a low pediment.
      return [
        box("feature", "accent", -halfX + 0.5, 1.1, halfZ - 0.15, 0.3, 2.2, 0.3),
        box("feature", "accent", -halfX + 1.7, 1.1, halfZ - 0.15, 0.3, 2.2, 0.3),
        box("feature", "accent", halfX - 1.7, 1.1, halfZ - 0.15, 0.3, 2.2, 0.3),
        box("feature", "accent", halfX - 0.5, 1.1, halfZ - 0.15, 0.3, 2.2, 0.3),
        box("feature", "wall", 0, top + 0.2, 0, halfX * 1.2, 0.4, halfZ * 1.2),
      ];
  }
}

/** One window instance: center on the wall, yaw 0 on a south wall, a quarter turn on an east wall. */
export interface WindowSite {
  areaId: AreaId;
  x: number;
  y: number;
  z: number;
  yaw: number;
}

const WINDOW_SPACING = 1.2;
const WINDOW_MARGIN = 1;
const ROW_START = 1.5;
const ROW_STEP = 1.3;
const ROW_TOP_CLEARANCE = 0.7;
const WALL_OFFSET = 0.02;

function wallSites(
  areaId: AreaId,
  wallWidth: number,
  height: number,
  place: (along: number, y: number) => WindowSite,
  skip: (along: number) => boolean,
): WindowSite[] {
  const columns = Math.floor((wallWidth - WINDOW_MARGIN * 2) / WINDOW_SPACING) + 1;
  const sites: WindowSite[] = [];
  for (let y = ROW_START; y <= height - ROW_TOP_CLEARANCE; y += ROW_STEP) {
    for (let c = 0; c < columns; c++) {
      const along = (c - (columns - 1) / 2) * WINDOW_SPACING;
      if (skip(along)) continue;
      sites.push({ ...place(along, y), areaId });
    }
  }
  return sites;
}

/**
 * Window positions for every building, on the two walls the camera sees (south and east). The
 * scene draws all of them with one instanced mesh. The door column on the south wall stays clear.
 */
export function windowSites(layout: CityLayout): WindowSite[] {
  const sites: WindowSite[] = [];
  for (const area of layout.areas) {
    const { cx, cz, halfX, halfZ } = area.footprint;
    sites.push(
      ...wallSites(
        area.id,
        halfX * 2,
        area.height,
        (along, y) => ({ areaId: area.id, x: cx + along, y, z: cz + halfZ + WALL_OFFSET, yaw: 0 }),
        (along) => Math.abs(along) < DOOR.w,
      ),
      ...wallSites(
        area.id,
        halfZ * 2,
        area.height,
        (along, y) => ({
          areaId: area.id,
          x: cx + halfX + WALL_OFFSET,
          y,
          z: cz + along,
          yaw: Math.PI / 2,
        }),
        () => false,
      ),
    );
  }
  return sites;
}
