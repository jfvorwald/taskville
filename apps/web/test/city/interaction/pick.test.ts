import {
  BoxGeometry,
  Group,
  InstancedMesh,
  Mesh,
  MeshBasicMaterial,
  OrthographicCamera,
  Scene,
} from "three";
import { describe, expect, it } from "vitest";
import { collectPickables, createPicker, ownerOf } from "../../../src/city/interaction/pick.ts";

const geometry = new BoxGeometry(1, 1, 1);
const material = new MeshBasicMaterial();

function agentGroup(id: string, x: number, z: number): Group {
  const g = new Group();
  g.userData = { agentId: id };
  g.position.set(x, 0.5, z);
  g.add(new Mesh(geometry, material));
  return g;
}

function building(id: string, x: number, z: number, size = 4): Group {
  const g = new Group();
  g.name = `building-${id}`;
  const m = new Mesh(geometry, material);
  m.scale.set(size, size, size);
  m.position.set(x, size / 2, z);
  g.add(m);
  return g;
}

function scene(): Scene {
  const s = new Scene();
  s.add(agentGroup("a1", 0, 0));
  const city = new Group();
  city.name = "city";
  const buildings = new Group();
  buildings.name = "buildings";
  buildings.add(building("review", 10, 0));
  buildings.add(new InstancedMesh(geometry, material, 4));
  city.add(buildings);
  s.add(city);
  return s;
}

function topCamera(): OrthographicCamera {
  const cam = new OrthographicCamera(-10, 10, 10, -10, 0.1, 100);
  cam.up.set(0, 0, -1);
  cam.position.set(0, 20, 0);
  cam.lookAt(0, 0, 0);
  cam.updateMatrixWorld();
  return cam;
}

describe("collectPickables", () => {
  it("finds agent roots and building groups, ignoring instanced meshes", () => {
    const out = collectPickables(scene(), []);
    expect(out.map((o) => o.userData.agentId ?? o.name).sort()).toEqual(["a1", "building-review"]);
  });

  it("finds agents wrapped in plain groups and clears the output array first", () => {
    const s = new Scene();
    const wrap = new Group();
    wrap.add(agentGroup("deep", 0, 0));
    s.add(wrap);
    const out = [new Group()];
    collectPickables(s, out);
    expect(out).toHaveLength(1);
    expect(out[0]?.userData.agentId).toBe("deep");
  });
});

describe("ownerOf", () => {
  it("names the agent or the area that owns a hit object", () => {
    const a = agentGroup("a1", 0, 0);
    const b = building("review", 0, 0);
    expect(ownerOf(a.children[0] ?? a)).toBe("a1");
    expect(ownerOf(b.children[0] ?? b)).toBe("area:review");
    expect(ownerOf(new Mesh(geometry, material))).toBeNull();
  });
});

describe("picker", () => {
  const cam = topCamera();
  const s = scene();
  s.updateMatrixWorld(true);
  const pickables = collectPickables(s, []);
  const picker = createPicker();

  it("picks the agent under the pointer", () => {
    // Ortho view: x in [-10,10] maps to ndc [-1,1]; z points down the screen.
    expect(picker.pick(0, 0, cam, pickables)).toBe("a1");
  });

  it("picks a building under the pointer", () => {
    expect(picker.pick(0.9, 0, cam, pickables)).toBe("area:review");
  });

  it("returns null over empty ground", () => {
    expect(picker.pick(-0.8, 0.8, cam, pickables)).toBeNull();
  });

  it("looks through areas the caller says are faded", () => {
    expect(picker.pick(0.9, 0, cam, pickables, (id) => id === "area:review")).toBeNull();
  });
});
