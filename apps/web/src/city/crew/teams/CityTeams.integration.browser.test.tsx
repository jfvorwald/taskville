import { Canvas, type RootState, type ThreeEvent } from "@react-three/fiber";
import { type Mesh, type Object3D, type Sprite, Vector3 } from "three";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  OTHER_TASK,
  PROJECT,
  TASK,
  TEAM,
  teamScenario,
} from "../../../../test/city/crew/teams/integration.fixture.ts";
import { dataStore } from "../../../data/store.ts";
import { worldAnchors } from "../../../overlays/host/index.ts";
import { sharedGeometries } from "../../agents/resources.ts";
import { CityRoot } from "../../index.tsx";
import { CITY_LAYOUT } from "../../layout/index.ts";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { movementLabels } from "../../movement/labels.ts";

const WAIT = { timeout: 10_000 };
afterEach(() => dataStore.getState().reset(PROJECT));

async function stage() {
  const scenario = teamScenario();
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(scenario.state);
  let root: RootState | undefined;
  const screen = await render(
    <div style={{ width: 320, height: 240 }}>
      <Canvas
        frameloop="never"
        onCreated={(s) => {
          root = s;
        }}
      >
        <CityRoot />
      </Canvas>
    </div>,
  );
  const all = () => {
    const out: Object3D[] = [];
    root?.scene.traverse((o) => out.push(o));
    return out;
  };
  const bodies = () =>
    all().filter(
      (o) =>
        o.userData.agentId !== undefined &&
        o.children.some((c) => (c as Mesh).geometry === sharedGeometries().torso),
    );
  await vi.waitFor(() => expect(bodies()).toHaveLength(3), WAIT);
  const frame = (seconds: number) => root?.advance(seconds);
  frame(0);
  frame(0.02);
  const camera = () => {
    if (!root) throw new Error("CityRoot canvas did not mount");
    return root.get().camera;
  };
  return { ...scenario, screen, all, bodies, frame, camera };
}

function world(o: Object3D) {
  o.updateWorldMatrix(true, false);
  return o.getWorldPosition(new Vector3());
}

function isDrawn(o: Object3D): boolean {
  for (let p: Object3D | null = o; p; p = p.parent) if (!p.visible) return false;
  let drawable = false;
  o.traverseVisible((c) => {
    if (c.type === "Mesh" || c.type === "Sprite") drawable = true;
  });
  return drawable;
}

type Stage = Awaited<ReturnType<typeof stage>>;
type Direction = "previous" | "next";
const rows = (s: Stage) =>
  s
    .all()
    .filter((o) => o.userData.teamId === TEAM && o.userData.taskId !== undefined && isDrawn(o));
const rowIds = (s: Stage): string[] => rows(s).map((o) => o.userData.taskId);
// Only rendered paging controls need this additional semantic marker.
// teamId + queuePageDirection identifies a drawable control, not page-state metadata.
const controls = (s: Stage, direction: Direction) =>
  s
    .all()
    .filter(
      (o) =>
        o.userData.teamId === TEAM && o.userData.queuePageDirection === direction && isDrawn(o),
    );

function expectInCamera(s: Stage, object: Object3D) {
  const camera = s.camera();
  camera.updateWorldMatrix(true, false);
  object.updateWorldMatrix(true, true);
  let drawn = 0;
  object.traverseVisible((child) => {
    const points: Vector3[] = [];
    if (child.type === "Sprite") {
      const scale = child.getWorldScale(new Vector3());
      const center = (child as Sprite).center;
      for (const x of [0, 1])
        for (const y of [0, 1]) {
          points.push(
            new Vector3((x - center.x) * scale.x, (y - center.y) * scale.y, 0)
              .applyQuaternion(camera.quaternion)
              .add(world(child)),
          );
        }
    } else if (child.type === "Mesh") {
      const geometry = (child as Mesh).geometry;
      geometry.computeBoundingBox();
      const box = geometry.boundingBox;
      expect(box).not.toBeNull();
      if (!box) return;
      for (const x of [box.min.x, box.max.x])
        for (const y of [box.min.y, box.max.y]) {
          for (const z of [box.min.z, box.max.z]) {
            points.push(new Vector3(x, y, z).applyMatrix4(child.matrixWorld));
          }
        }
    }
    for (const point of points) {
      drawn++;
      const projected = point.project(camera);
      const label = `${object.userData.taskId ?? object.userData.queuePageDirection} drawn corner`;
      expect(Math.abs(projected.x), `${label} fits camera X`).toBeLessThanOrEqual(1);
      expect(Math.abs(projected.y), `${label} fits camera Y`).toBeLessThanOrEqual(1);
      expect(Math.abs(projected.z), `${label} fits camera depth`).toBeLessThanOrEqual(1);
    }
  });
  expect(drawn, "selector must contain actual drawn geometry").toBeGreaterThan(0);
}

function expectReachablePage(s: Stage) {
  expect(rows(s).length).toBeGreaterThan(0);
  for (const row of rows(s)) {
    expect(world(row).y, `${row.userData.taskId} above ground`).toBeGreaterThan(0);
    expectInCamera(s, row);
  }
  for (const direction of ["previous", "next"] as const) {
    for (const control of controls(s, direction)) expectInCamera(s, control);
  }
}

async function populateQueue(s: Stage, count: number) {
  const ids = [
    TASK,
    ...Array.from({ length: count - 1 }, (_, i) => `claude-code:task:integration:${i + 2}`),
  ];
  for (const id of ids.slice(1)) dataStore.getState().applyEvent(s.createTask(id));
  // All envelopes share their recorded timestamp, so the documented ID tie-break applies.
  ids.sort();
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  await vi.waitFor(() => expect(rows(s).length).toBeGreaterThan(0), WAIT);
  return ids;
}

async function clickControl(s: Stage, direction: Direction) {
  const found = controls(s, direction);
  expect(found, `rendered ${direction} queue control`).toHaveLength(1);
  const control = found[0];
  if (!control) throw new Error(`Missing ${direction} queue control`);
  expectInCamera(s, control);
  // Invoke the handler R3F mounted on the drawn object (or its hit mesh), as a
  // component test. No React setter, synthetic page state or production test hook.
  const objects: Object3D[] = [];
  control.traverseVisible((o) => objects.push(o));
  const handler = objects
    .map(
      (o) =>
        (
          o as Object3D & {
            __r3f?: { handlers: { onClick?: (e: ThreeEvent<MouseEvent>) => void } };
          }
        ).__r3f?.handlers.onClick,
    )
    .find((fn) => fn !== undefined);
  expect(handler, `${direction} control has a mounted click handler`).toBeTypeOf("function");
  handler?.({
    object: control,
    eventObject: control,
    point: world(control),
    nativeEvent: new MouseEvent("click"),
    stopPropagation() {},
  } as ThreeEvent<MouseEvent>);
  await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
}

async function turnPage(s: Stage, direction: Direction, expected?: string[]) {
  const before = rowIds(s);
  await clickControl(s, direction);
  await vi.waitFor(() => {
    if (expected) expect(rowIds(s)).toEqual(expected);
    else expect(rowIds(s)).not.toEqual(before);
  }, WAIT);
}

async function expectBoundary(s: Stage, direction: Direction) {
  const before = rowIds(s);
  // Boundary controls may disappear or remain drawn and inert.
  if (controls(s, direction).length > 0) await clickControl(s, direction);
  expect(rowIds(s)).toEqual(before);
}

async function visitQueue(s: Stage, expected: string[]) {
  const pages: string[][] = [];
  const seen: string[] = [];
  await expectBoundary(s, "previous");
  for (let attempts = 0; attempts < expected.length; attempts++) {
    expectReachablePage(s);
    const page = rowIds(s);
    if (expected.length === 40) expect(page.length, "bounded mounted queue").toBeLessThan(40);
    expect(page).toEqual(expected.slice(seen.length, seen.length + page.length));
    seen.push(...page);
    pages.push(page);
    if (seen.length === expected.length) break;
    await turnPage(s, "next");
  }
  expect(seen).toEqual(expected);
  expect(new Set(seen).size).toBe(expected.length);
  await expectBoundary(s, "next");
  return pages;
}

// Like the existing agentId/isHull scene selectors, these narrow semantic markers identify
// the new decorations without pinning geometry, component names, or a new presentation API:
// hardHat=true, taskId/state for queue entries, teammateId/state for progress pips.
// Assertions require mounted drawable objects, not just selector return values or metadata.
describe("team visuals mounted through CityRoot", () => {
  it("draws full-size teammates with a shared scarf and a visible hard hat above the lead", async () => {
    const s = await stage();
    try {
      const scarves = s
        .bodies()
        .map(
          (g) => g.children.find((c) => (c as Mesh).geometry === sharedGeometries().scarf) as Mesh,
        );
      expect(s.bodies().every((g) => g.scale.x === 1)).toBe(true);
      expect(new Set(scarves.map((m) => m.material)).size).toBe(1);
      expect(scarves.every(isDrawn)).toBe(true);
      const lead = s.bodies().find((g) => g.userData.agentId === "lead");
      const hats = s.all().filter((o) => o.userData.hardHat === true && isDrawn(o));
      expect(hats).toHaveLength(1);
      const hat = hats[0];
      expect(hat).toBeDefined();
      if (!hat || !lead) return;
      const head = lead.children.find((c) => (c as Mesh).geometry === sharedGeometries().head);
      expect(head).toBeDefined();
      if (!head) return;
      expect(world(hat).y).toBeGreaterThan(world(head).y);
      expect(world(hat).x).toBeCloseTo(world(lead).x);
      expect(world(hat).z).toBeCloseTo(world(lead).z);
      expect(movementLabels.getSnapshot().find((r) => r.id === "pip")?.name).toBe("pip");
    } finally {
      await s.screen.unmount();
    }
  }, 30_000);

  it("walks a claiming teammate from Dispatch while the label anchor follows the same body", async () => {
    const s = await stage();
    try {
      const pip = s.bodies().find((g) => g.userData.agentId === "pip");
      expect(pip).toBeDefined();
      if (!pip) return;
      const start = world(pip);
      expect(
        CITY_LAYOUT.slots
          .filter((slot) => slot.areaId === "dispatch")
          .some((slot) => Math.hypot(slot.x - start.x, slot.z - start.z) < 0.01),
      ).toBe(true);
      dataStore.getState().applyEvent(s.claim());
      dataStore.getState().applyEvent(s.work());
      await vi.waitFor(
        () =>
          expect(movementLabels.getSnapshot().find((r) => r.id === "pip")?.status).toBe("Testing"),
        WAIT,
      );
      s.frame(0.12);
      s.frame(0.22);
      const walking = world(pip);
      expect(Math.hypot(walking.x - start.x, walking.z - start.z)).toBeGreaterThan(0);
      expect(movementLabels.getSnapshot().find((r) => r.id === "pip")?.onTheWay).toBe(true);
      const anchor = worldAnchors.getAnchor(agentAnchorId("pip"));
      expect(anchor?.[0]).toBeCloseTo(walking.x);
      expect(anchor?.[2]).toBeCloseTo(walking.z);
      for (let t = 0.32; t <= 120; t += 0.1) s.frame(t);
      const end = world(pip);
      expect(
        CITY_LAYOUT.slots
          .filter((slot) => slot.areaId === "test_lab")
          .some((slot) => Math.hypot(slot.x - end.x, slot.z - end.z) < 0.01),
      ).toBe(true);
    } finally {
      await s.screen.unmount();
    }
  }, 30_000);

  it.each([16, 40])(
    "pages through every recorded task in order within the default camera (%i tasks)",
    async (count) => {
      const s = await stage();
      try {
        const ids = await populateQueue(s, count);
        const pages = await visitQueue(s, ids);
        if (count === 40) expect(pages.length).toBeGreaterThan(1);
        // Go back through the actual mounted controls, retaining the same order and rows.
        for (const page of pages.slice(0, -1).reverse()) {
          await turnPage(s, "previous", page);
          expectReachablePage(s);
        }
        await expectBoundary(s, "previous");
        expect(rowIds(s)).toEqual(pages[0]);
      } finally {
        await s.screen.unmount();
      }
    },
    30_000,
  );

  it("clamps the displayed queue after a live snapshot shrinks the final page", async () => {
    const s = await stage();
    try {
      const ids = await populateQueue(s, 40);
      expect(controls(s, "next"), "large queue has a rendered next control").toHaveLength(1);
      const pages = await visitQueue(s, ids);
      expect(pages.length).toBeGreaterThan(1);
      expect(rowIds(s)).not.toContain(TASK);
      // A reconnect/replay snapshot can replace the queue while the city stays mounted.
      // Use the real store boundary, never the component's internal page state.
      dataStore.getState().applySnapshotState(s.state);
      await vi.waitFor(() => expect(rowIds(s)).toEqual([TASK]), WAIT);
      expectReachablePage(s);
      await expectBoundary(s, "previous");
      await expectBoundary(s, "next");
      // Growing again must not restore an obsolete final-page offset.
      for (const id of ids.filter((id) => id !== TASK)) {
        dataStore.getState().applyEvent(s.createTask(id));
      }
      await vi.waitFor(() => expect(rowIds(s)).toEqual(pages[0]), WAIT);
      await visitQueue(s, ids);
    } finally {
      await s.screen.unmount();
    }
  }, 30_000);

  it("updates Dispatch queue and teammate progress from the store's recorded task events", async () => {
    const s = await stage();
    try {
      const rows = () =>
        s
          .all()
          .filter(
            (o) => o.userData.teamId === TEAM && o.userData.taskId !== undefined && isDrawn(o),
          );
      const pips = () =>
        s
          .all()
          .filter(
            (o) => o.userData.teamId === TEAM && o.userData.teammateId !== undefined && isDrawn(o),
          );
      await vi.waitFor(() => expect(rows().map((o) => o.userData.taskId)).toEqual([TASK]), WAIT);
      expect(rows().some((o) => o.userData.taskId === OTHER_TASK)).toBe(false);
      expect(rows()[0]?.userData.state).toBe("pending");
      expect(
        pips()
          .map((o) => o.userData.teammateId)
          .sort(),
      ).toEqual(["bo", "pip"]);
      dataStore.getState().applyEvent(s.claim());
      await vi.waitFor(() => expect(rows()[0]?.userData.state).toBe("claimed"), WAIT);
      await vi.waitFor(
        () =>
          expect(pips().find((o) => o.userData.teammateId === "pip")?.userData.state).toBe(
            "claimed",
          ),
        WAIT,
      );
      dataStore.getState().applyEvent(s.complete());
      await vi.waitFor(() => expect(rows()[0]?.userData.state).toBe("completed"), WAIT);
      await vi.waitFor(
        () =>
          expect(pips().find((o) => o.userData.teammateId === "pip")?.userData.state).toBe(
            "completed",
          ),
        WAIT,
      );
      const dispatch = CITY_LAYOUT.areas.find((a) => a.id === "dispatch");
      expect(dispatch).toBeDefined();
      expect(pips().every((o) => world(o).y > (dispatch?.height ?? 0))).toBe(true);
    } finally {
      await s.screen.unmount();
    }
  }, 30_000);
});
