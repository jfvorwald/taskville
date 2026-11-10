import { useMemo } from "react";
import { BoxGeometry } from "three";
import type { CityLayout } from "../layout/index.ts";
import { Instances, type InstanceTransform } from "./Instances.tsx";
import type { CityMaterials } from "./materials.ts";

const SLAB_THICKNESS = 0.6;
const STREET_HEIGHT = 0.04;
const PLAZA_HEIGHT = 0.08;

/** The ground slab, the streets and the plaza as flat boxes, one instanced mesh per material. */
export function Ground({ layout, materials }: { layout: CityLayout; materials: CityMaterials }) {
  const unit = useMemo(() => new BoxGeometry(1, 1, 1), []);
  const items = useMemo(() => {
    const { bounds, plaza } = layout;
    const slab: InstanceTransform[] = [
      {
        x: (bounds.minX + bounds.maxX) / 2,
        y: -SLAB_THICKNESS / 2,
        z: (bounds.minZ + bounds.maxZ) / 2,
        scale: { x: bounds.maxX - bounds.minX, y: SLAB_THICKNESS, z: bounds.maxZ - bounds.minZ },
      },
    ];
    const streets = layout.streets.map((s): InstanceTransform => {
      const length = s.to - s.from;
      const mid = (s.from + s.to) / 2;
      return s.axis === "x"
        ? {
            x: s.at,
            y: STREET_HEIGHT / 2,
            z: mid,
            scale: { x: s.width, y: STREET_HEIGHT, z: length },
          }
        : {
            x: mid,
            y: STREET_HEIGHT / 2,
            z: s.at,
            scale: { x: length, y: STREET_HEIGHT, z: s.width },
          };
    });
    const square: InstanceTransform[] = [
      {
        x: plaza.cx,
        y: PLAZA_HEIGHT / 2,
        z: plaza.cz,
        scale: { x: plaza.half * 2, y: PLAZA_HEIGHT, z: plaza.half * 2 },
      },
    ];
    const mark: InstanceTransform[] = [
      {
        x: plaza.cx,
        y: PLAZA_HEIGHT + 0.25,
        z: plaza.cz,
        scale: { x: 1.2, y: 0.5, z: 1.2 },
      },
    ];
    return { slab, streets, square, mark };
  }, [layout]);
  return (
    <group name="ground" matrixAutoUpdate={false}>
      <Instances geometry={unit} material={materials.lambert.ground} items={items.slab} />
      <Instances geometry={unit} material={materials.lambert.street} items={items.streets} />
      <Instances geometry={unit} material={materials.lambert.plaza} items={items.square} />
      <Instances geometry={unit} material={materials.lambert.plazaMark} items={items.mark} />
    </group>
  );
}
