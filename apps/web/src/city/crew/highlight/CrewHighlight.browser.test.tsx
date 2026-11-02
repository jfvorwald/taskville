import { Canvas, useFrame } from "@react-three/fiber";
import {
  BoxGeometry,
  Group,
  type Material,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
  type OrthographicCamera,
  type Scene,
  Vector3,
} from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../../test/data/fake-engine.ts";
import { createDataStore } from "../../../data/store.ts";
import { CameraDriver } from "../../interaction/CameraDriver.tsx";
import { createCameraRig } from "../../interaction/cameraRig.ts";
import { selectionStore } from "../../interaction/selection.ts";
import { agent, stateOf, sub } from "../subagents/testScene.tsx";
import { CrewHighlight } from "./CrewHighlight.tsx";
import { createHighlightStore } from "./highlightStore.ts";

// M5.08 red round 2: roborev jobs 6603 and 6611 on PR #329. A thin render test of CrewHighlight in
// a real R3F scene. The scene is built by hand: L (lead) at (2,0,2); c1 (L's subagent) at (4,0,-2);
// o (an unrelated agent, outside the family) at (-3,0,1). Each is a Group with userData.agentId.
//
// Interface these tests add or pin (everything else is the PR as it stands):
//   <CrewHighlight store inputs rig? reducedMotion? />
//     rig            the CameraRig the city's CameraDriver reads (default: the app-wide cameraRig).
//                    A crew pick moves the camera THROUGH the rig, so an orbited camera
//                    (azimuthOffset != 0) still ends up looking at the picked bot, with the same
//                    zoom and the same azimuthOffset. (CameraDriver rewrites the camera pose every
//                    frame while orbited, so moving the camera object directly is overwritten.)
//                    The rig therefore needs a ground focus (pan) that CameraDriver applies; its
//                    shape is the implementer's call; only the behavior below is pinned.
//     reducedMotion  true: hovering never lifts a bot (no bounce), and a pick moves the camera in
//                    one step (no interpolated frames in between).
//   Dimming: a mesh swapped back to a pooled material by another system every frame must not make
//     fade clones pile up: live (cloned, not yet disposed) clones stay bounded, all are disposed
//     when the tab closes, and the pooled material itself is never disposed.
//   FollowRing: hidden (mesh.visible false, or detached) while its agent has no visible scene
//     group: group removed from the scene, or the group or an ancestor has visible = false.
//   The rings are the Mesh children of the "crew-highlight" group whose geometry.type is
//     "RingGeometry".

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const FRAME = { timeout: 5000 };

interface Harness {
  scene: Scene;
  camera: OrthographicCamera;
  groups: Record<string, Group>;
  pooled: MeshStandardMaterial;
  oMesh: Mesh;
  rig: ReturnType<typeof createCameraRig>;
  inputs: ReturnType<typeof createHighlightStore>;
  focusLog: { x: number; z: number }[];
}

const focusOf = (camera: OrthographicCamera) => {
  const dir = camera.getWorldDirection(new Vector3());
  const t = -camera.position.y / dir.y;
  return { x: camera.position.x + dir.x * t, z: camera.position.z + dir.z * t };
};

function Probe({ h }: { h: Harness }) {
  useFrame(({ camera }) => {
    h.focusLog.push(focusOf(camera as OrthographicCamera));
  });
  return null;
}
/** Another system (SubagentCrew) puts the pooled material back on the bot every frame. */
function Swapper({ h }: { h: Harness }) {
  useFrame(() => {
    h.oMesh.material = h.pooled;
  });
  return null;
}

async function mount(opts: { reducedMotion?: boolean; swap?: boolean } = {}): Promise<Harness> {
  const store = createDataStore({ now: () => 0 });
  store.getState().reset(PROJECT);
  store
    .getState()
    .applySnapshotState(
      stateOf([agent("L", { kind: "lead" }), sub("c1", "L"), agent("o", { kind: "session" })]),
    );
  const h = {
    groups: {},
    pooled: new MeshStandardMaterial({ color: 0x3366cc }),
    rig: createCameraRig(),
    inputs: createHighlightStore(),
    focusLog: [],
  } as unknown as Harness;
  const at: Record<string, [number, number, number]> = {
    L: [2, 0, 2],
    c1: [4, 0, -2],
    o: [-3, 0, 1],
  };
  render(
    <div style={{ width: 300, height: 200 }}>
      <Canvas
        orthographic
        camera={{ position: [10, 8, 10], zoom: 40 }}
        onCreated={(state) => {
          state.camera.lookAt(0, 0, 0);
          h.camera = state.camera as OrthographicCamera;
          h.scene = state.scene;
          for (const [id, p] of Object.entries(at)) {
            const g = new Group();
            g.userData.agentId = id;
            g.position.set(...p);
            const mesh = new Mesh(new BoxGeometry(0.5, 0.5, 0.5), h.pooled);
            g.add(mesh);
            if (id === "o") h.oMesh = mesh;
            state.scene.add(g);
            h.groups[id] = g;
          }
        }}
      >
        <CameraDriver rig={h.rig} />
        <CrewHighlight
          store={store}
          inputs={h.inputs}
          rig={h.rig}
          reducedMotion={opts.reducedMotion === true}
        />
        <Probe h={h} />
        {opts.swap === true && <Swapper h={h} />}
      </Canvas>
    </div>,
  );
  await vi.waitFor(() => expect(h.groups.o).toBeDefined(), FRAME);
  await wait(150);
  return h;
}

afterEach(() => selectionStore.select(null));

const near = (a: { x: number; z: number }, b: { x: number; z: number }) =>
  Math.hypot(a.x - b.x, a.z - b.z);

describe("camera ease on a crew pick", () => {
  it("works while the camera is orbited: target moves, zoom and azimuth stay", async () => {
    const h = await mount();
    h.rig.orbitBy(90);
    await vi.waitFor(() => expect(h.camera.position.z).toBeCloseTo(-10, 3), FRAME);
    const zoom = h.camera.zoom;
    h.inputs.open("L");
    await wait(100);
    selectionStore.select("c1");
    await vi.waitFor(() => expect(near(focusOf(h.camera), { x: 4, z: -2 })).toBeLessThan(0.05), {
      timeout: 4000,
    });
    expect(h.camera.zoom).toBeCloseTo(zoom, 6);
    expect(h.rig.getSnapshot().azimuthOffset).toBe(90);
  });
});

describe("reduced motion", () => {
  it("moves the camera in one step, with no interpolated frames", async () => {
    const h = await mount({ reducedMotion: true });
    h.inputs.open("L");
    await wait(100);
    const start = focusOf(h.camera);
    h.focusLog.length = 0;
    selectionStore.select("c1");
    await vi.waitFor(() => expect(near(focusOf(h.camera), { x: 4, z: -2 })).toBeLessThan(0.05), {
      timeout: 4000,
    });
    await wait(100);
    const between = h.focusLog.filter(
      (p) => near(p, start) > 0.05 && near(p, { x: 4, z: -2 }) > 0.05,
    );
    expect(between).toEqual([]);
  });

  it("never lifts a hovered bot", async () => {
    const h = await mount({ reducedMotion: true });
    h.inputs.open("L");
    h.inputs.hover("c1");
    // Judge over drawn frames, not wall-clock time: 60 frames after the hover, the bounce window
    // (450 ms) has been drawn through on any machine fast enough to finish the run.
    const seen = h.focusLog.length;
    let max = 0;
    await vi.waitFor(
      () => {
        max = Math.max(max, h.groups.c1?.position.y ?? 0);
        expect(h.focusLog.length).toBeGreaterThanOrEqual(seen + 60);
      },
      { timeout: 30_000, interval: 5 },
    );
    expect(max).toBe(0);
  });

  it("(guard, passes today) still bounces a hovered bot when motion is allowed", async () => {
    const h = await mount();
    h.inputs.open("L");
    // A hop lasts 450 ms; if no frame was drawn during it, arrive again until one was.
    let max = 0;
    for (let attempt = 0; attempt < 10 && !(max > 0.01); attempt++) {
      h.inputs.hover(null);
      const start = h.focusLog.length;
      await vi.waitFor(() => expect(h.focusLog.length).toBeGreaterThanOrEqual(start + 3), {
        timeout: 30_000,
      });
      h.inputs.hover("c1");
      const after = h.focusLog.length;
      await vi.waitFor(
        () => {
          max = Math.max(max, h.groups.c1?.position.y ?? 0);
          expect(h.focusLog.length).toBeGreaterThanOrEqual(after + 40);
        },
        { timeout: 30_000, interval: 5 },
      );
    }
    expect(max).toBeGreaterThan(0.01);
  });
});

describe("fade clones for bots outside the family", () => {
  it("stay bounded while another system keeps swapping the material back, and are disposed on close", async () => {
    const h = await mount({ swap: true });
    const real = h.pooled.clone.bind(h.pooled);
    const clones: Material[] = [];
    const disposed = new Set<Material>();
    vi.spyOn(h.pooled, "clone").mockImplementation(() => {
      const c = real();
      c.addEventListener("dispose", () => disposed.add(c));
      clones.push(c);
      return c;
    });
    const poolDispose = vi.spyOn(h.pooled, "dispose");
    h.inputs.open("L");
    await wait(600);
    const live = () => clones.filter((c) => !disposed.has(c)).length;
    expect(clones.length).toBeGreaterThan(0);
    expect(live()).toBeLessThanOrEqual(2);
    h.inputs.open(null);
    await wait(300);
    expect(live()).toBe(0);
    expect(poolDispose).not.toHaveBeenCalled();
  });
});

describe("family rings", () => {
  const ringFor = (h: Harness, id: string): Object3D => {
    const rings = (h.scene.getObjectByName("crew-highlight")?.children ?? []).filter(
      (o) => (o as Mesh).isMesh && (o as Mesh).geometry.type === "RingGeometry",
    );
    const want = h.groups[id]?.position as Vector3;
    const ring = rings.find((r) => Math.hypot(r.position.x - want.x, r.position.z - want.z) < 0.01);
    if (ring === undefined) throw new Error(`no ring on ${id}`);
    return ring;
  };
  const shown = (o: Object3D) => o.visible && o.parent !== null;

  it("shows the child's ring on the child while its group is in the scene", async () => {
    const h = await mount();
    h.inputs.open("L");
    await vi.waitFor(() => expect(shown(ringFor(h, "c1"))).toBe(true), FRAME);
  });

  it("hides the ring when the bot's group is removed from the scene", async () => {
    const h = await mount();
    h.inputs.open("L");
    await vi.waitFor(() => expect(shown(ringFor(h, "c1"))).toBe(true), FRAME);
    const ring = ringFor(h, "c1");
    h.groups.c1?.removeFromParent();
    await wait(200);
    expect(shown(ring)).toBe(false);
  });

  it("hides the ring when the bot's group is hidden (behind a crew marker)", async () => {
    const h = await mount();
    h.inputs.open("L");
    await vi.waitFor(() => expect(shown(ringFor(h, "c1"))).toBe(true), FRAME);
    const ring = ringFor(h, "c1");
    (h.groups.c1 as Group).visible = false;
    await wait(200);
    expect(shown(ring)).toBe(false);
  });
});

// Round 3, S2: a tether must not be frustum-culled. Its geometry is rewritten each frame and its
// bounding sphere is never recomputed, so after the camera pans to a child it would vanish.
// S1: with no Crew tab open the highlight is idle: it must not walk the scene every frame.
describe("tethers and idle cost", () => {
  it("never frustum-culls a tether", async () => {
    const h = await mount();
    h.inputs.open("L");
    await wait(200);
    const lines: Object3D[] = [];
    h.scene.getObjectByName("crew-highlight")?.traverse((o) => {
      if ((o as { isLineSegments?: boolean }).isLineSegments === true) lines.push(o);
    });
    expect(lines.length).toBeGreaterThan(0);
    expect(lines.every((l) => l.frustumCulled === false)).toBe(true);
  });

  it("does not traverse the scene each frame while no Crew tab is open", async () => {
    const h = await mount();
    const traverse = vi.spyOn(h.scene, "traverse");
    await wait(400);
    expect(traverse).not.toHaveBeenCalled();
    // And it still works once a tab opens (guard, passes today).
    h.inputs.open("L");
    await wait(200);
    expect(traverse).toHaveBeenCalled();
  });
});
