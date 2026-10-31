import { type BufferGeometry, type Material, Mesh, type Object3D, Vector3 } from "three";

export interface Size3 {
  x: number;
  y: number;
  z: number;
}

/**
 * Scale for a hull mesh so it extends `thickness` meters past the part on every side, whatever
 * the part's size and world scale. `size` is the geometry's own size, `worldScale` the part's.
 */
export function hullScale(size: Size3, worldScale: Size3, thickness: number, out: Size3): Size3 {
  out.x = 1 + (2 * thickness) / Math.max(size.x * worldScale.x, 1e-6);
  out.y = 1 + (2 * thickness) / Math.max(size.y * worldScale.y, 1e-6);
  out.z = 1 + (2 * thickness) / Math.max(size.z * worldScale.z, 1e-6);
  return out;
}

export interface HullGlow {
  /** Puts an inverted hull under every mesh of `root`, replacing any previous target. */
  attach(root: Object3D): void;
  detach(): void;
  readonly target: Object3D | null;
}

const worldScale = new Vector3();
const scaleOut: Size3 = { x: 1, y: 1, z: 1 };
const meshes: Mesh[] = [];

function geometrySize(g: BufferGeometry, out: Size3): Size3 {
  if (g.boundingBox === null) g.computeBoundingBox();
  const b = g.boundingBox;
  out.x = b ? b.max.x - b.min.x : 1;
  out.y = b ? b.max.y - b.min.y : 1;
  out.z = b ? b.max.z - b.min.z : 1;
  return out;
}

const sizeOut: Size3 = { x: 1, y: 1, z: 1 };

/**
 * The glow is an inverted hull, not bloom: a slightly larger copy of each mesh, drawn back faces
 * only with a flat color, so a rim shows past the silhouette. Hulls are children of the meshes
 * they copy, so they follow animation for free. They are pooled: moving the glow from one thing
 * to another reuses the same Mesh objects, and nothing is created per frame.
 */
export function createHullGlow(material: Material, thickness: number): HullGlow {
  const pool: Mesh[] = [];
  let active = 0;
  let current: Object3D | null = null;

  const take = (): Mesh => {
    let hull = pool[active];
    if (hull === undefined) {
      hull = new Mesh(undefined, material);
      hull.userData.isHull = true;
      hull.raycast = () => {};
      hull.castShadow = false;
      hull.receiveShadow = false;
      pool.push(hull);
    }
    active++;
    return hull;
  };

  const detach = () => {
    for (let i = 0; i < active; i++) pool[i]?.removeFromParent();
    active = 0;
    current = null;
  };

  return {
    attach(root) {
      detach();
      root.updateWorldMatrix(true, true);
      meshes.length = 0;
      root.traverse((o) => {
        const m = o as Mesh;
        if (
          m.isMesh === true &&
          !(m as unknown as { isInstancedMesh?: boolean }).isInstancedMesh &&
          o.userData.isHull !== true
        ) {
          meshes.push(m);
        }
      });
      for (const mesh of meshes) {
        const hull = take();
        hull.geometry = mesh.geometry;
        mesh.getWorldScale(worldScale);
        hullScale(geometrySize(mesh.geometry, sizeOut), worldScale, thickness, scaleOut);
        hull.scale.set(scaleOut.x, scaleOut.y, scaleOut.z);
        hull.position.set(0, 0, 0);
        mesh.add(hull);
      }
      meshes.length = 0;
      current = root;
    },
    detach,
    get target() {
      return current;
    },
  };
}
