import { BoxGeometry, Group, InstancedMesh, Matrix4, Mesh, MeshLambertMaterial } from "three";
import { describe, expect, it } from "vitest";
import { createBuildingFader } from "../../../src/city/interaction/fade.ts";
import { windowSites } from "../../../src/city/buildings/parts.ts";
import { CITY_LAYOUT } from "../../../src/city/layout/index.ts";

const wall = new MeshLambertMaterial({ color: "#aaa" });
const roof = new MeshLambertMaterial({ color: "#777" });

function city() {
  const root = new Group();
  const buildings = new Group();
  buildings.name = "buildings";
  const meshes = new Map<string, Mesh[]>();
  for (const area of CITY_LAYOUT.areas) {
    const g = new Group();
    g.name = `building-${area.id}`;
    const a = new Mesh(new BoxGeometry(), wall);
    const b = new Mesh(new BoxGeometry(), roof);
    g.add(a, b);
    meshes.set(area.id, [a, b]);
    buildings.add(g);
  }
  const sites = windowSites(CITY_LAYOUT);
  const windows = new InstancedMesh(new BoxGeometry(), new MeshLambertMaterial(), sites.length);
  const m = new Matrix4().makeTranslation(1, 2, 3);
  for (let i = 0; i < sites.length; i++) windows.setMatrixAt(i, m);
  buildings.add(windows);
  root.add(buildings);
  return { root, meshes, windows, sites };
}

const first = CITY_LAYOUT.areas[0]?.id ?? "dispatch";
const second = CITY_LAYOUT.areas[1]?.id ?? "workshop";

describe("building fader", () => {
  it("leaves every building on its shared material while nothing is faded", () => {
    const { root, meshes } = city();
    const fader = createBuildingFader({ sites: windowSites(CITY_LAYOUT) });
    fader.bind(root);
    fader.update(1, () => false);
    expect(meshes.get(first)?.map((m) => m.material)).toEqual([wall, roof]);
  });

  it("fades a wanted building to the faded opacity on cloned materials, others untouched", () => {
    const { root, meshes } = city();
    const fader = createBuildingFader({ sites: windowSites(CITY_LAYOUT), fadedOpacity: 0.2, seconds: 0.5 });
    fader.bind(root);
    fader.update(10, (id) => id === first);
    const faded = meshes.get(first)?.[0]?.material as MeshLambertMaterial;
    expect(faded).not.toBe(wall);
    expect(faded.transparent).toBe(true);
    expect(faded.opacity).toBeCloseTo(0.2);
    expect(faded.color.getHex()).toBe(wall.color.getHex());
    expect(meshes.get(second)?.[0]?.material).toBe(wall);
    expect(wall.opacity).toBe(1);
  });

  it("eases over time instead of jumping", () => {
    const { root, meshes } = city();
    const fader = createBuildingFader({ sites: windowSites(CITY_LAYOUT), fadedOpacity: 0.2, seconds: 1 });
    fader.bind(root);
    fader.update(0.25, (id) => id === first);
    const mid = (meshes.get(first)?.[0]?.material as MeshLambertMaterial).opacity;
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(0.2);
  });

  it("restores the original shared material once fully faded back in", () => {
    const { root, meshes } = city();
    const fader = createBuildingFader({ sites: windowSites(CITY_LAYOUT), fadedOpacity: 0.2, seconds: 0.5 });
    fader.bind(root);
    fader.update(10, (id) => id === first);
    fader.update(10, () => false);
    expect(meshes.get(first)?.map((m) => m.material)).toEqual([wall, roof]);
  });

  it("hides the instanced windows of a faded building and brings them back", () => {
    const { root, windows, sites } = city();
    const fader = createBuildingFader({ sites, fadedOpacity: 0.2, seconds: 0.5 });
    fader.bind(root);
    const m = new Matrix4();
    const idx = sites.findIndex((s) => s.areaId === first);
    const other = sites.findIndex((s) => s.areaId === second);
    fader.update(10, (id) => id === first);
    windows.getMatrixAt(idx, m);
    expect(m.elements[0]).toBe(0);
    windows.getMatrixAt(other, m);
    expect(m.elements[0]).not.toBe(0);
    fader.update(10, () => false);
    windows.getMatrixAt(idx, m);
    expect(m.elements[0]).not.toBe(0);
  });

  it("reports whether anything changed, so a still scene does no work", () => {
    const { root } = city();
    const fader = createBuildingFader({ sites: windowSites(CITY_LAYOUT), seconds: 0.5 });
    fader.bind(root);
    expect(fader.update(0.016, () => false)).toBe(false);
    expect(fader.update(0.016, (id) => id === first)).toBe(true);
  });

  it("disposes the cloned materials", () => {
    const { root } = city();
    const fader = createBuildingFader({ sites: windowSites(CITY_LAYOUT), seconds: 0.1 });
    fader.bind(root);
    fader.update(1, () => true);
    expect(() => fader.dispose()).not.toThrow();
  });
});
