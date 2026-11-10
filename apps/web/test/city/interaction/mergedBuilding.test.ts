import {
  BackSide,
  Box3,
  BoxGeometry,
  Group,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshBasicMaterial,
  MeshLambertMaterial,
  Vector3,
} from "three";
import { describe, expect, it } from "vitest";
import { buildingParts, windowSites } from "../../../src/city/buildings/parts.ts";
import { createBuildingFader } from "../../../src/city/interaction/fade.ts";
import { createHullGlow } from "../../../src/city/interaction/hull.ts";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";

const area = CITY_LAYOUT.areas[0];
if (area === undefined) throw new Error("the layout has no areas");
const parts = buildingParts(area);
const boxes = parts.map((p) => ({ position: p.position, size: p.size }));

/** A building as the city builds it: `building-<id>` group, one merged mesh listing its boxes. */
function mergedBuilding(): { group: Group; mesh: Mesh; material: MeshLambertMaterial } {
  const material = new MeshLambertMaterial({ vertexColors: true });
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.userData = { boxes };
  const group = new Group();
  group.name = `building-${area?.id}`;
  group.add(mesh);
  group.updateMatrixWorld(true);
  return { group, mesh, material };
}

function hullsUnder(root: Group): Mesh[] {
  const found: Mesh[] = [];
  root.traverse((o) => {
    if (o.userData.isHull === true) found.push(o as Mesh);
  });
  return found;
}

describe("hover hull on a merged building", () => {
  const thickness = 0.05;
  const hullMaterial = new MeshBasicMaterial({ side: BackSide });

  it("draws one hull per box in userData.boxes", () => {
    const { group } = mergedBuilding();
    expect(boxes.length).toBeGreaterThan(1);
    createHullGlow(hullMaterial, thickness).attach(group);
    expect(hullsUnder(group)).toHaveLength(boxes.length);
  });

  it("places and sizes each hull around its own box, slightly larger than it", () => {
    const { group, mesh } = mergedBuilding();
    createHullGlow(hullMaterial, thickness).attach(group);
    const hulls = hullsUnder(group);
    boxes.forEach((box, i) => {
      const hull = hulls[i];
      expect(hull).toBeDefined();
      if (hull === undefined) return;
      expect(hull.parent).toBe(mesh);
      expect(hull.position.x).toBeCloseTo(box.position.x);
      expect(hull.position.y).toBeCloseTo(box.position.y);
      expect(hull.position.z).toBeCloseTo(box.position.z);
      // The hull geometry is a unit box, so its scale is its size: the box plus the thickness on
      // every side.
      expect(hull.scale.x).toBeCloseTo(box.size.x + 2 * thickness);
      expect(hull.scale.y).toBeCloseTo(box.size.y + 2 * thickness);
      expect(hull.scale.z).toBeCloseTo(box.size.z + 2 * thickness);
      const world = new Box3().setFromObject(hull);
      const size = world.getSize(new Vector3());
      expect(size.x).toBeGreaterThan(box.size.x);
      expect(size.y).toBeGreaterThan(box.size.y);
      expect(size.z).toBeGreaterThan(box.size.z);
      const center = world.getCenter(new Vector3());
      expect(center.x).toBeCloseTo(box.position.x);
      expect(center.y).toBeCloseTo(box.position.y);
      expect(center.z).toBeCloseTo(box.position.z);
    });
  });

  it("keeps hulls off the merged mesh's origin when the boxes are away from it", () => {
    const { group } = mergedBuilding();
    createHullGlow(hullMaterial, thickness).attach(group);
    const offOrigin = hullsUnder(group).filter(
      (h) => Math.abs(h.position.x) + Math.abs(h.position.y) + Math.abs(h.position.z) > 1e-3,
    );
    expect(offOrigin.length).toBeGreaterThan(0);
  });

  it("removes every hull when un-hovered", () => {
    const { group } = mergedBuilding();
    const glow = createHullGlow(hullMaterial, thickness);
    glow.attach(group);
    expect(hullsUnder(group).length).toBeGreaterThan(0);
    glow.detach();
    expect(hullsUnder(group)).toHaveLength(0);
    expect(glow.target).toBeNull();
  });
});

describe("fade on a merged building mesh", () => {
  it("clones the mesh's material and lowers its opacity when occluding, leaving the shared one", () => {
    const { group, mesh, material } = mergedBuilding();
    const root = new Group();
    const buildings = new Group();
    buildings.name = "buildings";
    const sites = windowSites(CITY_LAYOUT);
    const windows = new InstancedMesh(new BoxGeometry(), new MeshLambertMaterial(), sites.length);
    for (let i = 0; i < sites.length; i++) windows.setMatrixAt(i, new Matrix4());
    buildings.add(group, windows);
    root.add(buildings);
    const fader = createBuildingFader({ sites, fadedOpacity: 0.2, seconds: 0.5 });
    fader.bind(root);
    fader.update(10, (id) => id === area?.id);
    const faded = mesh.material as MeshLambertMaterial;
    expect(faded).not.toBe(material);
    expect(faded.transparent).toBe(true);
    expect(faded.vertexColors).toBe(true);
    expect(faded.opacity).toBeCloseTo(0.2);
    expect(material.opacity).toBe(1);
  });
});
