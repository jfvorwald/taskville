import { useCallback } from "react";
import { type BufferGeometry, type InstancedMesh, type Material, Object3D } from "three";

export interface InstanceTransform {
  x: number;
  y: number;
  z: number;
  yaw?: number;
  /** One number for a uniform scale, or per-axis sizes for a stretched unit box. */
  scale?: number | { x: number; y: number; z: number };
}

const scratch = new Object3D();

/**
 * One instanced mesh for a repeated part (windows, lamps, trees). Transforms are written once
 * when the list changes, or when the mesh is rebuilt for a new geometry or material (they are
 * constructor arguments); nothing is allocated per frame.
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
  // A ref callback, not an effect: a new geometry or material rebuilds the mesh (they are
  // constructor arguments) and React calls the ref with the new one.
  const place = useCallback(
    (mesh: InstancedMesh | null) => {
      if (!mesh) return;
      // Static: the mesh sits at the origin, so its matrix is composed once and never again.
      mesh.updateMatrix();
      items.forEach((item, i) => {
        scratch.position.set(item.x, item.y, item.z);
        scratch.rotation.set(0, item.yaw ?? 0, 0);
        const scale = item.scale ?? 1;
        if (typeof scale === "number") scratch.scale.setScalar(scale);
        else scratch.scale.set(scale.x, scale.y, scale.z);
        scratch.updateMatrix();
        mesh.setMatrixAt(i, scratch.matrix);
      });
      mesh.count = items.length;
      mesh.instanceMatrix.needsUpdate = true;
      mesh.computeBoundingSphere();
    },
    [items],
  );
  return (
    <instancedMesh
      key={items.length}
      ref={place}
      args={[geometry, material, Math.max(items.length, 1)]}
      frustumCulled={false}
      matrixAutoUpdate={false}
    />
  );
}
