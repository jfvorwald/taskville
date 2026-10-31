import { BoxGeometry, Group, InstancedMesh, Mesh, MeshBasicMaterial, BackSide } from "three";
import { describe, expect, it } from "vitest";
import { createHullGlow, hullScale } from "../../../src/city/interaction/hull.ts";

const material = new MeshBasicMaterial({ side: BackSide });

function agentLike(scale = 1): Group {
  const g = new Group();
  g.scale.setScalar(scale);
  g.add(new Mesh(new BoxGeometry(0.4, 0.4, 0.2)));
  const arm = new Group();
  arm.add(new Mesh(new BoxGeometry(0.1, 0.34, 0.1)));
  g.add(arm);
  g.updateMatrixWorld(true);
  return g;
}

describe("hullScale", () => {
  it("adds a constant thickness on every side whatever the part size", () => {
    const out = { x: 0, y: 0, z: 0 };
    hullScale({ x: 0.4, y: 0.2, z: 1 }, { x: 1, y: 1, z: 1 }, 0.05, out);
    expect(out.x).toBeCloseTo(1 + 0.1 / 0.4);
    expect(out.y).toBeCloseTo(1 + 0.1 / 0.2);
    expect(out.z).toBeCloseTo(1 + 0.1 / 1);
  });

  it("accounts for the world scale of the part", () => {
    const out = { x: 0, y: 0, z: 0 };
    hullScale({ x: 1, y: 1, z: 1 }, { x: 4, y: 2, z: 1 }, 0.1, out);
    expect(out.x).toBeCloseTo(1 + 0.2 / 4);
    expect(out.y).toBeCloseTo(1 + 0.2 / 2);
  });
});

describe("hull glow", () => {
  it("adds one back-face hull under every mesh of the target and removes them again", () => {
    const glow = createHullGlow(material, 0.04);
    const target = agentLike();
    glow.attach(target);
    const hulls: Mesh[] = [];
    target.traverse((o) => {
      if (o.userData.isHull) hulls.push(o as Mesh);
    });
    expect(hulls).toHaveLength(2);
    expect(hulls.every((h) => h.material === material)).toBe(true);
    expect(glow.target).toBe(target);
    glow.detach();
    let left = 0;
    target.traverse((o) => {
      if (o.userData.isHull) left++;
    });
    expect(left).toBe(0);
    expect(glow.target).toBeNull();
  });

  it("moves to a new target, and reuses hull meshes instead of allocating new ones", () => {
    const glow = createHullGlow(material, 0.04);
    const a = agentLike();
    glow.attach(a);
    let first: unknown;
    a.traverse((o) => {
      if (o.userData.isHull && first === undefined) first = o;
    });
    glow.attach(agentLike());
    glow.detach();
    const b = agentLike();
    glow.attach(b);
    let again: unknown;
    b.traverse((o) => {
      if (o.userData.isHull && again === undefined) again = o;
    });
    expect(again).toBe(first);
  });

  it("scales hulls so thickness stays constant when the agent itself is scaled", () => {
    const glow = createHullGlow(material, 0.04);
    const target = agentLike(0.5);
    glow.attach(target);
    let hull: Mesh | undefined;
    target.traverse((o) => {
      if (o.userData.isHull && hull === undefined) hull = o as Mesh;
    });
    expect(hull?.scale.x).toBeCloseTo(1 + (2 * 0.04) / (0.4 * 0.5));
  });

  it("does not pick up instanced meshes, and its hulls cannot be hit by rays", () => {
    const glow = createHullGlow(material, 0.04);
    const target = agentLike();
    target.add(new InstancedMesh(new BoxGeometry(), material, 2));
    glow.attach(target);
    const hulls: Mesh[] = [];
    target.traverse((o) => {
      if (o.userData.isHull) hulls.push(o as Mesh);
    });
    expect(hulls).toHaveLength(2);
    const hit: unknown[] = [];
    // biome-ignore lint/suspicious/noExplicitAny: raycaster stub, only the call matters
    hulls[0]?.raycast({} as any, hit as any);
    expect(hit).toHaveLength(0);
  });
});
