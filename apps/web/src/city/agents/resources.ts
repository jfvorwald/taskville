import { BoxGeometry, type BufferGeometry, CylinderGeometry, MeshStandardMaterial } from "three";

// Pooled GPU resources. Every bot shares these geometries, and materials are cached by color, so
// adding the hundredth bot allocates no geometry and only a new color costs one material.

let geometries: Geometries | undefined;
const materials = new Map<string, MeshStandardMaterial>();

interface Geometries {
  torso: BufferGeometry;
  head: BufferGeometry;
  limb: BufferGeometry;
  leg: BufferGeometry;
  scarf: BufferGeometry;
  hammerHandle: BufferGeometry;
  hammerHead: BufferGeometry;
  beaker: BufferGeometry;
  pages: BufferGeometry;
}

export function sharedGeometries(): Geometries {
  geometries ??= {
    torso: new BoxGeometry(0.36, 0.4, 0.2),
    head: new BoxGeometry(0.26, 0.26, 0.26),
    limb: new BoxGeometry(0.1, 0.34, 0.1),
    leg: new BoxGeometry(0.13, 0.35, 0.13),
    scarf: new BoxGeometry(0.4, 0.07, 0.25),
    hammerHandle: new BoxGeometry(0.04, 0.28, 0.04),
    hammerHead: new BoxGeometry(0.16, 0.08, 0.08),
    beaker: new CylinderGeometry(0.06, 0.05, 0.14, 10),
    pages: new BoxGeometry(0.2, 0.02, 0.16),
  };
  return geometries;
}

export function colorMaterial(hex: string): MeshStandardMaterial {
  let m = materials.get(hex);
  if (m === undefined) {
    m = new MeshStandardMaterial({ color: hex, roughness: 0.8, metalness: 0 });
    materials.set(hex, m);
  }
  return m;
}

/** Drops every pooled resource. For tests and a full scene teardown. */
export function disposeAgentResources(): void {
  if (geometries !== undefined) {
    for (const g of Object.values(geometries)) g.dispose();
    geometries = undefined;
  }
  for (const m of materials.values()) m.dispose();
  materials.clear();
}
