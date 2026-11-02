import { type Mesh, type Object3D, RingGeometry, type Sprite } from "three";
import { describe, expect, it, vi } from "vitest";
import { userEvent } from "vitest/browser";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { crewMarkerLabel, FAN_OUT_MS } from "./crew.ts";
import { FADE_MS, HAND_OVER_MS, RETURN_MS } from "./lifecycle.ts";
import { pillMaterial } from "./resources.ts";
import { FRAME_WAIT, isShown, LEAD, mount, type Scene, sub, T, WORKING_MS } from "./testScene.tsx";

const FOUR = [LEAD, sub("s1", "lead"), sub("s2", "lead"), sub("s3", "lead"), sub("s4", "lead")];

async function collapsed(nested = false) {
  const agents = nested ? [...FOUR, sub("nested", "s4")] : FOUR;
  const scene = await mount(agents, { anchor: [0, 0, 0], interaction: true, size: [480, 360] });
  await scene.frames(2);
  scene.clock.now = WORKING_MS;
  await vi.waitFor(() => expect(scene.shown("s3")).toBe(true), FRAME_WAIT);
  await scene.frames(3);
  const markers = scene.spritesOf([pillMaterial(crewMarkerLabel(1))]);
  expect(markers).toHaveLength(1);
  expect(scene.shown("s4")).toBe(false);
  return { scene, marker: markers[0] as Sprite };
}

function onCanvas(scene: Scene, object: Object3D, lift = 0) {
  const camera = scene.root().camera;
  camera.updateMatrixWorld();
  const point = scene.at(object);
  point.y += lift;
  point.project(camera);
  const rect = scene.root().gl.domElement.getBoundingClientRect();
  return { x: ((point.x + 1) / 2) * rect.width, y: ((1 - point.y) / 2) * rect.height };
}

async function fanOut(scene: Scene, marker: Sprite) {
  await userEvent.click(scene.root().gl.domElement, { position: onCanvas(scene, marker) });
  await vi.waitFor(() => expect(scene.shown("s4")).toBe(true), FRAME_WAIT);
  await scene.frames(3);
}

async function collapse(scene: Scene) {
  scene.clock.now += FAN_OUT_MS + 1;
  await vi.waitFor(() => expect(scene.shown("s4")).toBe(false), FRAME_WAIT);
  await scene.frames(3);
}

function anchorAt(scene: Scene, id: string, object: Object3D, marker: boolean) {
  const actual = scene.anchors.getAnchor(agentAnchorId(id));
  const point = scene.at(object);
  // Soft assertions let the real pointer transition and cleanup controls run after the first red.
  expect.soft(actual, `${id} has an anchor at its visible representative`).toBeDefined();
  expect.soft(actual?.[0], `${id} anchor x`).toBeCloseTo(point.x, 5);
  expect.soft(actual?.[2], `${id} anchor z`).toBeCloseTo(point.z, 5);
  if (marker) expect.soft(actual?.[1], `${id} marker anchor y`).toBeCloseTo(point.y, 5);
}

function selectionRing(scene: Scene): Mesh {
  // InteractionLayer creates an unnamed circular RingGeometry(0.62, 0.8, 40).
  // Inspect the actual rendered mesh, never a fabricated selection object or source hook.
  const rings = scene.find((object) => {
    const mesh = object as Mesh;
    return (
      mesh.isMesh === true &&
      mesh.geometry instanceof RingGeometry &&
      mesh.geometry.parameters.thetaSegments === 40 &&
      mesh.renderOrder === 10
    );
  });
  expect(rings).toHaveLength(1);
  return rings[0] as Mesh;
}

function ringAt(scene: Scene, target: Object3D, id: string) {
  const ring = selectionRing(scene);
  expect.soft(isShown(ring), "actual selection ring is visible").toBe(true);
  const actual = scene.at(ring);
  const point = scene.at(target);
  expect.soft(actual.x, "selection ring x").toBeCloseTo(point.x, 5);
  expect.soft(actual.z, "selection ring z").toBeCloseTo(point.z, 5);
  expect(scene.selection.getSnapshot()).toBe(id);
}

describe("M5.18 visible crew marker ownership", () => {
  it("keeps a running child's marker fallback when its hidden parent finishes", async () => {
    const { scene, marker } = await collapsed(true);
    try {
      scene.set([...FOUR.slice(0, -1), sub("s4", "lead", { finishedAt: T }), sub("nested", "s4")]);
      await scene.frames(5);
      scene.selection.select("nested");
      await scene.frames(5);
      anchorAt(scene, "nested", marker, true);
      ringAt(scene, marker, "nested");
      anchorAt(scene, "s4", marker, true);
      scene.clock.now += RETURN_MS + HAND_OVER_MS + FADE_MS + 1;
      await scene.frames(8);
      await vi.waitFor(() => expect(scene.bot("s4")).toBeUndefined(), FRAME_WAIT);
      expect(scene.anchors.getAnchor(agentAnchorId("s4"))).toBeUndefined();
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("selects counted descendants at their visible count or ancestor marker and clears removed IDs", async () => {
    const agents = [...FOUR, sub("nested", "s4"), sub("deep", "nested")];
    const scene = await mount(agents, { anchor: [0, 0, 0], interaction: true, size: [480, 360] });
    try {
      await scene.frames(3);
      scene.clock.now = WORKING_MS;
      await scene.frames(5);
      const [marker] = scene.spritesOf([pillMaterial(crewMarkerLabel(1))]);
      expect(marker).toBeDefined();
      scene.selection.select("deep");
      await scene.frames(5);
      ringAt(scene, marker as Sprite, "deep");
      anchorAt(scene, "deep", marker as Sprite, true);
      await fanOut(scene, marker as Sprite);
      const [deeper] = scene.spritesOf([pillMaterial("1 deeper")]);
      expect(deeper).toBeDefined();
      ringAt(scene, deeper as Sprite, "deep");
      anchorAt(scene, "deep", deeper as Sprite, true);
      await collapse(scene);
      ringAt(scene, marker as Sprite, "deep");
      anchorAt(scene, "deep", marker as Sprite, true);
      scene.set(agents.slice(0, -1));
      await scene.frames(5);
      await vi.waitFor(() => expect(scene.selection.getSnapshot()).toBeNull(), FRAME_WAIT);
      expect(isShown(selectionRing(scene))).toBe(false);
      expect(scene.anchors.getAnchor(agentAnchorId("deep"))).toBeUndefined();
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("publishes the fourth child's bubble anchor at the marker, bot on fan-out, then marker again", async () => {
    const { scene, marker } = await collapsed();
    try {
      anchorAt(scene, "s4", marker, true);
      // Normal drawn children retain their actual bot anchors.
      anchorAt(scene, "s3", scene.bot("s3") as Object3D, false);
      await fanOut(scene, marker);
      anchorAt(scene, "s4", scene.bot("s4") as Object3D, false);
      await collapse(scene);
      expect(isShown(marker)).toBe(true);
      anchorAt(scene, "s4", marker, true);
      await scene.removeLayer();
      await scene.frames(3);
      expect(scene.anchors.getAnchor(agentAnchorId("s4"))).toBeUndefined();
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("routes a nested hidden child's anchor to the same visible marker and restores its bot on fan-out", async () => {
    const { scene, marker } = await collapsed(true);
    try {
      expect(scene.shown("nested")).toBe(false);
      anchorAt(scene, "nested", marker, true);
      await fanOut(scene, marker);
      await vi.waitFor(() => expect(scene.shown("nested")).toBe(true), FRAME_WAIT);
      anchorAt(scene, "nested", scene.bot("nested") as Object3D, false);
      await collapse(scene);
      expect(scene.shown("nested")).toBe(false);
      anchorAt(scene, "nested", marker, true);
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it.each(["s4", "nested"])(
    "shows list-selected hidden %s at the marker without changing its ID",
    async (id) => {
      const { scene, marker } = await collapsed(id === "nested");
      try {
        // The public selection store is also how the accessible agent list selects an agent.
        scene.selection.select(id);
        await scene.frames(5);
        ringAt(scene, marker, id);
        await fanOut(scene, marker);
        ringAt(scene, scene.bot(id) as Object3D, id);
        await collapse(scene);
        ringAt(scene, marker, id);
      } finally {
        await scene.unmount();
      }
    },
    60_000,
  );

  it("moves a pointer-selected fourth bot's visible ring to the marker on collapse and back on fan-out", async () => {
    const { scene, marker } = await collapsed();
    try {
      await fanOut(scene, marker);
      const bot = scene.bot("s4") as Object3D;
      await userEvent.click(scene.root().gl.domElement, { position: onCanvas(scene, bot, 0.3) });
      await vi.waitFor(() => expect(scene.selection.getSnapshot()).toBe("s4"), FRAME_WAIT);
      await scene.frames(3);
      ringAt(scene, bot, "s4");
      await collapse(scene);
      ringAt(scene, marker, "s4");
      await fanOut(scene, marker);
      ringAt(scene, bot, "s4");
    } finally {
      await scene.unmount();
    }
  }, 60_000);

  it("keeps drawn-bot selection, empty-ground clearing and removal cleanup working", async () => {
    const { scene } = await collapsed();
    try {
      const bot = scene.bot("s3") as Object3D;
      await userEvent.click(scene.root().gl.domElement, { position: onCanvas(scene, bot, 0.3) });
      await vi.waitFor(() => expect(scene.selection.getSnapshot()).toBe("s3"), FRAME_WAIT);
      await scene.frames(3);
      ringAt(scene, bot, "s3");
      await userEvent.click(scene.root().gl.domElement, { position: { x: 4, y: 4 } });
      await scene.frames(3);
      expect(scene.selection.getSnapshot()).toBeNull();
      expect(isShown(selectionRing(scene))).toBe(false);
      scene.selection.select("s3");
      await scene.frames(3);
      expect(isShown(selectionRing(scene))).toBe(true);
      scene.set([LEAD]);
      await vi.waitFor(() => expect(scene.selection.getSnapshot()).toBeNull(), FRAME_WAIT);
      expect(isShown(selectionRing(scene))).toBe(false);
      expect(scene.anchors.getAnchor(agentAnchorId("s3"))).toBeUndefined();
    } finally {
      await scene.unmount();
    }
  }, 60_000);
});
