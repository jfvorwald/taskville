import { useEffect, useMemo } from "react";
import {
  BoxGeometry,
  type BufferGeometry,
  Float32BufferAttribute,
  MeshLambertMaterial,
} from "three";
import { mergeGeometries } from "three/examples/jsm/utils/BufferGeometryUtils.js";
import type { CityLayout } from "../layout/index.ts";
import { Instances } from "./Instances.tsx";
import type { CityMaterials } from "./materials.ts";
import { type BuildingPart, buildingParts, windowSites } from "./parts.ts";

/**
 * One geometry for a whole building: its boxes baked into world space and merged, each box tinted
 * with its tone's color as a vertex color. The mesh stays one draw call, and hover and fade still
 * see a mesh under the `building-<id>` group.
 */
function mergeParts(parts: readonly BuildingPart[], materials: CityMaterials): BufferGeometry {
  const boxes = parts.map((part) => {
    const box = new BoxGeometry(part.size.x, part.size.y, part.size.z);
    box.translate(part.position.x, part.position.y, part.position.z);
    const { r, g, b } = materials.lambert[part.tone].color;
    const count = box.getAttribute("position").count;
    box.setAttribute("color", new Float32BufferAttribute(Array(count).fill([r, g, b]).flat(), 3));
    return box;
  });
  const merged = mergeGeometries(boxes, false);
  for (const box of boxes) box.dispose();
  return merged;
}

/**
 * The six work-area buildings: one merged mesh each (tones as vertex colors), plus every window
 * drawn as one instanced mesh. Each mesh lists its boxes in `userData.boxes` so the hover glow can
 * outline the parts rather than the whole merged shape.
 */
export function Buildings({ layout, materials }: { layout: CityLayout; materials: CityMaterials }) {
  const windowGeometry = useMemo(() => new BoxGeometry(0.55, 0.7, 0.08), []);
  // White, so the vertex colors show as they are; the fade clones it per building.
  const material = useMemo(() => new MeshLambertMaterial({ vertexColors: true }), []);
  const parts = useMemo(
    () => layout.areas.map((area) => ({ id: area.id, parts: buildingParts(area) })),
    [layout],
  );
  // Tone colors are baked in, so a new palette (new materials) rebuilds the geometry.
  const buildings = useMemo(
    () =>
      parts.map((building) => ({
        id: building.id,
        boxes: building.parts.map((p) => ({ position: p.position, size: p.size })),
        geometry: mergeParts(building.parts, materials),
      })),
    [parts, materials],
  );
  useEffect(
    () => () => {
      for (const building of buildings) building.geometry.dispose();
    },
    [buildings],
  );
  useEffect(() => () => material.dispose(), [material]);
  const windows = useMemo(() => windowSites(layout), [layout]);
  return (
    <group name="buildings" matrixAutoUpdate={false}>
      {buildings.map((building) => (
        <group key={building.id} name={`building-${building.id}`} matrixAutoUpdate={false}>
          <mesh
            geometry={building.geometry}
            material={material}
            userData={{ boxes: building.boxes }}
            matrixAutoUpdate={false}
          />
        </group>
      ))}
      <Instances geometry={windowGeometry} material={materials.windowGlow} items={windows} />
    </group>
  );
}
