import { Canvas, type RootState } from "@react-three/fiber";
import { BoxGeometry, type InstancedMesh, MeshBasicMaterial } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { Instances, type InstanceTransform } from "./Instances.tsx";

// M3.24 (roborev 5603): a theme switch hands Instances a new material. React Three Fiber builds a
// fresh instanced mesh (the material is a constructor argument) but the matrix effect only reruns
// when `items` changes, so the new mesh kept identity matrices and the windows, lamps and trees
// collapsed onto the origin.

const geometry = new BoxGeometry(1, 1, 1);
const items: readonly InstanceTransform[] = [
  { x: 5, y: 1, z: 0 },
  { x: -7, y: 2, z: 3 },
  { x: 0, y: 3, z: -9 },
];

function Scene({ material }: { material: MeshBasicMaterial }) {
  return (
    <div style={{ width: 200, height: 150 }}>
      <Canvas
        onCreated={(s) => {
          state = s;
        }}
      >
        <Instances geometry={geometry} material={material} items={items} />
      </Canvas>
    </div>
  );
}

let state: RootState | undefined;

function instancedMesh(): InstancedMesh {
  const mesh = state?.scene.children.find((c) => (c as InstancedMesh).isInstancedMesh);
  if (!mesh) throw new Error("no instanced mesh in the scene");
  return mesh as InstancedMesh;
}

/** The x, y, z translation of each instance. */
function translations(mesh: InstancedMesh): number[][] {
  const a = mesh.instanceMatrix.array;
  return Array.from({ length: mesh.count }, (_, i) => [
    a[i * 16 + 12] ?? Number.NaN,
    a[i * 16 + 13] ?? Number.NaN,
    a[i * 16 + 14] ?? Number.NaN,
  ]);
}

const expected = items.map((i) => [i.x, i.y, i.z]);

describe("Instances", () => {
  it("keeps every instance placed after the material changes (a theme switch)", async () => {
    const screen = await render(<Scene material={new MeshBasicMaterial({ color: "#336699" })} />);
    await vi.waitFor(() => expect(state).toBeDefined());
    const first = instancedMesh();
    expect(translations(first)).toEqual(expected);

    const next = new MeshBasicMaterial({ color: "#cc9933" });
    await screen.rerender(<Scene material={next} />);
    await new Promise((r) => setTimeout(r, 200)); // let a few frames render

    const mesh = instancedMesh();
    expect(mesh.material).toBe(next);
    expect(mesh.count).toBe(items.length);
    expect(translations(mesh)).toEqual(expected);
    expect(mesh.boundingSphere?.radius ?? 0).toBeGreaterThan(1);
  });
});
