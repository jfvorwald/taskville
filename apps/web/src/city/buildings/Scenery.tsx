import { useMemo } from "react";
import { BoxGeometry } from "three";
import type { CityLayout } from "../layout/index.ts";
import { Instances, type InstanceTransform } from "./Instances.tsx";
import type { CityMaterials } from "./materials.ts";

const POLE_HEIGHT = 2.2;
const TRUNK_HEIGHT = 0.8;
const CROWN_SIZE = 1.1;

/** Lamps and trees, every repeated part drawn with one instanced mesh per shape. */
export function Scenery({ layout, materials }: { layout: CityLayout; materials: CityMaterials }) {
  const geometry = useMemo(
    () => ({
      pole: new BoxGeometry(0.12, POLE_HEIGHT, 0.12),
      head: new BoxGeometry(0.34, 0.3, 0.34),
      trunk: new BoxGeometry(0.25, TRUNK_HEIGHT, 0.25),
      crown: new BoxGeometry(CROWN_SIZE, CROWN_SIZE, CROWN_SIZE),
    }),
    [],
  );
  const items = useMemo(() => {
    const poles: InstanceTransform[] = [];
    const heads: InstanceTransform[] = [];
    for (const lamp of layout.props.lamps) {
      poles.push({ x: lamp.x, y: POLE_HEIGHT / 2, z: lamp.z });
      heads.push({ x: lamp.x, y: POLE_HEIGHT + 0.15, z: lamp.z });
    }
    const trunks: InstanceTransform[] = [];
    const crowns: InstanceTransform[] = [];
    for (const tree of layout.props.trees) {
      trunks.push({ x: tree.x, y: (TRUNK_HEIGHT * tree.scale) / 2, z: tree.z, scale: tree.scale });
      crowns.push({
        x: tree.x,
        y: TRUNK_HEIGHT * tree.scale + (CROWN_SIZE * tree.scale) / 2,
        z: tree.z,
        scale: tree.scale,
      });
    }
    return { poles, heads, trunks, crowns };
  }, [layout]);
  return (
    <group name="scenery">
      <Instances
        geometry={geometry.pole}
        material={materials.lambert.lampPole}
        items={items.poles}
      />
      <Instances geometry={geometry.head} material={materials.lampGlow} items={items.heads} />
      <Instances
        geometry={geometry.trunk}
        material={materials.lambert.treeTrunk}
        items={items.trunks}
      />
      <Instances
        geometry={geometry.crown}
        material={materials.lambert.treeCrown}
        items={items.crowns}
      />
    </group>
  );
}
