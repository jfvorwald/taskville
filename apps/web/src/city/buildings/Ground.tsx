import { useMemo } from "react";
import { BoxGeometry } from "three";
import type { CityLayout } from "../layout/index.ts";
import type { CityMaterials } from "./materials.ts";

const SLAB_THICKNESS = 0.6;
const STREET_HEIGHT = 0.04;
const PLAZA_HEIGHT = 0.08;

/** The ground slab, the streets and the plaza as flat boxes. */
export function Ground({ layout, materials }: { layout: CityLayout; materials: CityMaterials }) {
  const unit = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const { bounds, plaza } = layout;
  const width = bounds.maxX - bounds.minX;
  const depth = bounds.maxZ - bounds.minZ;
  return (
    <group name="ground">
      <mesh
        geometry={unit}
        material={materials.lambert.ground}
        position={[
          (bounds.minX + bounds.maxX) / 2,
          -SLAB_THICKNESS / 2,
          (bounds.minZ + bounds.maxZ) / 2,
        ]}
        scale={[width, SLAB_THICKNESS, depth]}
      />
      {layout.streets.map((s) => {
        const length = s.to - s.from;
        const mid = (s.from + s.to) / 2;
        return (
          <mesh
            key={`${s.axis}:${s.at}`}
            geometry={unit}
            material={materials.lambert.street}
            position={
              s.axis === "x" ? [s.at, STREET_HEIGHT / 2, mid] : [mid, STREET_HEIGHT / 2, s.at]
            }
            scale={
              s.axis === "x" ? [s.width, STREET_HEIGHT, length] : [length, STREET_HEIGHT, s.width]
            }
          />
        );
      })}
      <mesh
        geometry={unit}
        material={materials.lambert.plaza}
        position={[plaza.cx, PLAZA_HEIGHT / 2, plaza.cz]}
        scale={[plaza.half * 2, PLAZA_HEIGHT, plaza.half * 2]}
      />
      <mesh
        geometry={unit}
        material={materials.lambert.plazaMark}
        position={[plaza.cx, PLAZA_HEIGHT + 0.25, plaza.cz]}
        scale={[1.2, 0.5, 1.2]}
      />
    </group>
  );
}
