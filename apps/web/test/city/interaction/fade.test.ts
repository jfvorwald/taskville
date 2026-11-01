import {
  BoxGeometry,
  Group,
  InstancedMesh,
  type Material,
  Matrix4,
  Mesh,
  MeshLambertMaterial,
} from "three";
import { describe, expect, it, vi } from "vitest";
import { windowSites } from "../../../src/city/buildings/parts.ts";
import { createBuildingFader } from "../../../src/city/interaction/fade.ts";
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
    const fader = createBuildingFader({
      sites: windowSites(CITY_LAYOUT),
      fadedOpacity: 0.2,
      seconds: 0.5,
    });
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
    const fader = createBuildingFader({
      sites: windowSites(CITY_LAYOUT),
      fadedOpacity: 0.2,
      seconds: 1,
    });
    fader.bind(root);
    fader.update(0.25, (id) => id === first);
    const mid = ((meshes.get(first)?.[0]?.material ?? wall) as MeshLambertMaterial).opacity;
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(0.2);
  });

  it("restores the original shared material once fully faded back in", () => {
    const { root, meshes } = city();
    const fader = createBuildingFader({
      sites: windowSites(CITY_LAYOUT),
      fadedOpacity: 0.2,
      seconds: 0.5,
    });
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

describe("building fader and theme changes", () => {
  it("fades the materials a building has now, not the ones it had when bound", () => {
    const { root, meshes } = city();
    const fader = createBuildingFader({
      sites: windowSites(CITY_LAYOUT),
      fadedOpacity: 0.2,
      seconds: 0.5,
    });
    fader.bind(root);
    const themed = new MeshLambertMaterial({ color: "#ff00ff" });
    for (const m of meshes.get(first) ?? []) m.material = themed;
    fader.update(10, (id) => id === first);
    const during = meshes.get(first)?.[0]?.material as MeshLambertMaterial;
    expect(during.color.getHex()).toBe(themed.color.getHex());
    fader.update(10, () => false);
    expect(meshes.get(first)?.[0]?.material).toBe(themed);
  });
});

function watchDispose(m: Material) {
  const spy = vi.fn();
  m.addEventListener("dispose", spy);
  return spy;
}

describe("building fader when the theme changes mid-fade", () => {
  const options = { sites: windowSites(CITY_LAYOUT), fadedOpacity: 0.2, seconds: 0.5 };

  it.each([
    ["part way faded", 0.1],
    ["fully faded", 10],
  ])("ends on the new theme's materials when they arrived while %s", (_label, fadeSeconds) => {
    const { root, meshes } = city();
    const fader = createBuildingFader(options);
    fader.bind(root);
    fader.update(fadeSeconds, (id) => id === first);
    const list = meshes.get(first) ?? [];
    const oldClones = list.map((m) => m.material as Material);
    const oldDisposed = oldClones.map(watchDispose);

    const themedWall = new MeshLambertMaterial({ color: "#ff00ff" });
    const themedRoof = new MeshLambertMaterial({ color: "#00ffff" });
    const themedDisposed = [watchDispose(themedWall), watchDispose(themedRoof)];
    const [wallMesh, roofMesh] = list;
    if (wallMesh === undefined || roofMesh === undefined) throw new Error("fixture");
    wallMesh.material = themedWall;
    roofMesh.material = themedRoof;

    fader.update(10, () => false);

    expect(list[0]?.material).toBe(themedWall);
    expect(list[1]?.material).toBe(themedRoof);
    for (const spy of oldDisposed) expect(spy).toHaveBeenCalled();
    // The shared theme materials belong to the theme, not to the fader.
    for (const spy of themedDisposed) expect(spy).not.toHaveBeenCalled();
  });

  it("keeps fading, on clones of the new material, when the theme changes mid fade-out", () => {
    const { root, meshes } = city();
    const fader = createBuildingFader(options);
    fader.bind(root);
    fader.update(0.1, (id) => id === first);
    const before = fader.opacityOf(first);
    const list = meshes.get(first) ?? [];
    const oldDisposed = list.map((m) => watchDispose(m.material as Material));

    const themed = new MeshLambertMaterial({ color: "#ff00ff" });
    for (const m of list) m.material = themed;

    fader.update(0.05, (id) => id === first);
    const now = fader.opacityOf(first);
    expect(now).toBeLessThan(before);
    for (const m of list) {
      const mat = m.material as MeshLambertMaterial;
      expect(mat).not.toBe(themed);
      expect(mat.color.getHex()).toBe(themed.color.getHex());
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBeCloseTo(now);
    }
    expect(themed.opacity).toBe(1);
    for (const spy of oldDisposed) expect(spy).toHaveBeenCalled();

    fader.update(10, (id) => id === first);
    for (const m of list) expect((m.material as MeshLambertMaterial).opacity).toBeCloseTo(0.2);
  });

  it("fades a replacement material even when the building was already fully faded", () => {
    const { root, meshes } = city();
    const fader = createBuildingFader(options);
    fader.bind(root);
    fader.update(10, (id) => id === first);
    const list = meshes.get(first) ?? [];
    const themed = new MeshLambertMaterial({ color: "#ff00ff" });
    for (const m of list) m.material = themed;

    fader.update(0.016, (id) => id === first);
    const swapped = list.map((m) => m.material as MeshLambertMaterial);
    for (const mat of swapped) {
      expect(mat).not.toBe(themed);
      expect(mat.color.getHex()).toBe(themed.color.getHex());
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBeCloseTo(0.2);
    }

    // Once adopted, the clones are kept: no new clone per frame.
    fader.update(0.016, (id) => id === first);
    list.forEach((m, i) => {
      expect(m.material).toBe(swapped[i]);
    });
  });
});

describe("building fader when the theme changes while a building is solid", () => {
  const options = { sites: windowSites(CITY_LAYOUT), fadedOpacity: 0.2, seconds: 0.5 };

  it.each([
    ["on the next fade-out", false],
    ["after a solid frame", true],
  ])("fades the next fade-out on clones of the new material, %s", (_label, solidFrameFirst) => {
    const { root, meshes } = city();
    const fader = createBuildingFader(options);
    fader.bind(root);

    // Fade out and back in completely: the building is solid again, the clones are kept for reuse.
    fader.update(10, (id) => id === first);
    const list = meshes.get(first) ?? [];
    const oldClones = list.map((m) => m.material as Material);
    expect(oldClones[0]).not.toBe(wall);
    const oldDisposed = oldClones.map(watchDispose);
    fader.update(10, () => false);
    expect(list.map((m) => m.material)).toEqual([wall, roof]);

    // The theme changes while the building is solid.
    const themedWall = new MeshLambertMaterial({ color: "#ff00ff" });
    const themedRoof = new MeshLambertMaterial({ color: "#00ffff" });
    const themedDisposed = [watchDispose(themedWall), watchDispose(themedRoof)];
    const [wallMesh, roofMesh] = list;
    if (wallMesh === undefined || roofMesh === undefined) throw new Error("fixture");
    wallMesh.material = themedWall;
    roofMesh.material = themedRoof;
    if (solidFrameFirst) {
      fader.update(0.016, () => false);
      expect(list.map((m) => m.material)).toEqual([themedWall, themedRoof]);
    }

    // Fade out again: the faded materials are clones of the new theme, not the old theme's.
    fader.update(10, (id) => id === first);
    const now = list.map((m) => m.material as MeshLambertMaterial);
    expect(now[0]?.color.getHex()).toBe(themedWall.color.getHex());
    expect(now[1]?.color.getHex()).toBe(themedRoof.color.getHex());
    for (const mat of now) {
      expect(oldClones).not.toContain(mat);
      expect(mat.transparent).toBe(true);
      expect(mat.opacity).toBeCloseTo(0.2);
    }
    expect(now[0]).not.toBe(themedWall);
    expect(now[1]).not.toBe(themedRoof);
    // The old clones are released; the new shared materials belong to the theme and are not.
    for (const spy of oldDisposed) expect(spy).toHaveBeenCalled();
    for (const spy of themedDisposed) expect(spy).not.toHaveBeenCalled();
    expect(themedWall.opacity).toBe(1);
    expect(themedRoof.opacity).toBe(1);

    // And it still comes back to the new shared materials.
    fader.update(10, () => false);
    expect(list.map((m) => m.material)).toEqual([themedWall, themedRoof]);
  });
});

describe("building fader duration at runtime (reduced motion)", () => {
  it("completes a fade in one update at zero seconds, and restores the 0.25 s fade", () => {
    const { root } = city();
    const fader = createBuildingFader({ sites: windowSites(CITY_LAYOUT), fadedOpacity: 0.2 });
    fader.bind(root);

    fader.setSeconds(0);
    fader.update(0.016, (id) => id === first);
    expect(fader.opacityOf(first)).toBeCloseTo(0.2);
    fader.update(0.016, () => false);
    expect(fader.opacityOf(first)).toBe(1);

    fader.setSeconds(0.25);
    fader.update(0.05, (id) => id === first);
    const mid = fader.opacityOf(first);
    expect(mid).toBeLessThan(1);
    expect(mid).toBeGreaterThan(0.2);
    fader.update(0.2, (id) => id === first);
    expect(fader.opacityOf(first)).toBeCloseTo(0.2);
  });
});
