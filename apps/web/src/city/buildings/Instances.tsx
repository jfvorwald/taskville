import { useLayoutEffect, useRef } from "react";
import { type BufferGeometry, type InstancedMesh, type Material, Object3D } from "three";

export interface InstanceTransform {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  scale?: number;
}

const scratch = new Object3D();

/**
 * One instanced mesh for a repeated part (windows, lamps, trees). Transforms are written once
 * when the list changes; nothing is allocated per frame.
 */
export function Instances({
  geometry,
  material,
  items,
}: {
  geometry: BufferGeometry;
  material: Material;
  items: readonly InstanceTransform[];
}) {
  const ref = useRef<InstancedMesh>(null);
  useLayoutEffect(() => {
    const mesh = ref.current;
    if (!mesh) return;
    items.forEach((item, i) => {
      scratch.position.set(item.x, item.y, item.z);
      scratch.rotation.set(0, item.yaw ?? 0, 0);
      scratch.scale.setScalar(item.scale ?? 1);
      scratch.updateMatrix();
      mesh.setMatrixAt(i, scratch.matrix);
    });
    mesh.count = items.length;
    mesh.instanceMatrix.needsUpdate = true;
    mesh.computeBoundingSphere();
  }, [items]);
  return (
    <instancedMesh
      key={items.length}
      ref={ref}
      args={[geometry, material, Math.max(items.length, 1)]}
      frustumCulled={false}
    />
  );
}
