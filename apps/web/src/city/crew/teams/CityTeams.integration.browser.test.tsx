import { Canvas, type RootState } from "@react-three/fiber";
import { type Mesh, type Object3D, Vector3 } from "three";
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
  return { ...scenario, screen, all, bodies, frame };
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

  it("keeps every recorded task reachable above ground in a sixteen-task Dispatch queue", async () => {
    const s = await stage();
    try {
      const taskIds = [
        TASK,
        ...Array.from({ length: 15 }, (_, i) => `claude-code:task:integration:${i + 2}`),
      ];
      for (const id of taskIds.slice(1)) dataStore.getState().applyEvent(s.createTask(id));
      const rows = () =>
        s
          .all()
          .filter(
            (o) => o.userData.teamId === TEAM && o.userData.taskId !== undefined && isDrawn(o),
          );
      // The current queue displays all rows. A bounded UI can traverse its controls here
      // when introduced, retaining coverage that every recorded task can be reached.
      await vi.waitFor(
        () =>
          expect(
            rows()
              .map((o) => o.userData.taskId)
              .sort(),
          ).toEqual([...taskIds].sort()),
        WAIT,
      );
      for (const id of taskIds) {
        const row = rows().find((o) => o.userData.taskId === id);
        expect(row, `recorded task ${id} is reachable`).toBeDefined();
        if (!row) continue;
        expect(world(row).y, `recorded task ${id} is above ground`).toBeGreaterThan(0);
      }
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
