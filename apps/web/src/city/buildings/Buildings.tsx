import { useMemo } from "react";
import { BoxGeometry } from "three";
import type { CityLayout } from "../layout/index.ts";
import { Instances } from "./Instances.tsx";
import type { CityMaterials } from "./materials.ts";
import { buildingParts, windowSites } from "./parts.ts";

/**
 * The six work-area buildings: a handful of boxes each, plus every window drawn as one
 * instanced mesh. Geometry is unit boxes scaled per part, shared by all buildings.
 */
export function Buildings({ layout, materials }: { layout: CityLayout; materials: CityMaterials }) {
  const unit = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const windowGeometry = useMemo(() => new BoxGeometry(0.55, 0.7, 0.08), []);
  const parts = useMemo(
    () => layout.areas.map((area) => ({ id: area.id, parts: buildingParts(area) })),
    [layout],
  );
  const windows = useMemo(() => windowSites(layout), [layout]);
  return (
    <group name="buildings">
      {parts.map((building) => (
        <group key={building.id} name={`building-${building.id}`}>
          {building.parts.map((part, i) => (
            <mesh
              // biome-ignore lint/suspicious/noArrayIndexKey: parts are static per layout
              key={i}
              geometry={unit}
              material={materials.lambert[part.tone]}
              position={[part.position.x, part.position.y, part.position.z]}
              scale={[part.size.x, part.size.y, part.size.z]}
            />
          ))}
        </group>
      ))}
      <Instances geometry={windowGeometry} material={materials.windowGlow} items={windows} />
    </group>
  );
}
