import { Canvas, type RootState } from "@react-three/fiber";
import type { Mesh, Object3D } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import {
  completionScenario,
  MEMBER,
  OTHER,
  PROJECT,
  TASK,
  TEAM,
} from "../../../../test/city/crew/teams/completion.fixture.ts";
import type { ProjectState } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import type { AgentView } from "../../agents/types.ts";
import { TeamDecorations } from "./TeamDecorations.tsx";

const json = <T,>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

async function stage(state: ProjectState) {
  const store = createDataStore();
  store.getState().reset(PROJECT);
  store.getState().applySnapshotState(state);
  const views: AgentView[] = Object.values(state.agents).map((agent) => ({
    id: agent.id,
    kind: agent.kind,
    ...(agent.teamId === undefined ? {} : { teamId: agent.teamId }),
    activity: "idle",
    placement: { x: 0, y: 0, z: 0, heading: 0 },
  }));
  let root: RootState | undefined;
  const screen = await render(
    <div style={{ width: 320, height: 240 }}>
      <Canvas
        frameloop="never"
        onCreated={(s) => {
          root = s;
        }}
      >
        <TeamDecorations views={views} store={store} />
      </Canvas>
    </div>,
  );
  const drawn = () => {
    const objects: Object3D[] = [];
    root?.scene.traverseVisible((o) => objects.push(o));
    return objects;
  };
  const pips = () => drawn().filter((o) => o.userData.teamId === TEAM && o.userData.teammateId);
  const pip = (id: string) => pips().find((o) => o.userData.teammateId === id) as Mesh | undefined;
  const row = () => drawn().find((o) => o.userData.taskId === TASK);
  await vi.waitFor(() => expect(pips()).toHaveLength(2));
  // Assert a visible mesh with real geometry/material, not detached selector metadata.
  for (const id of [MEMBER, OTHER]) {
    expect(pip(id)?.isMesh).toBe(true);
    expect(pip(id)?.geometry).toBeDefined();
    expect(pip(id)?.material).toBeDefined();
  }
  return { store, screen, pip, row };
}

describe("recorded completion progress without task assignment", () => {
  it("draws only the recorded actor as completed live and after JSON snapshot/replay, then clears on reopen", async () => {
    const scenario = completionScenario();
    expect(scenario.tasks.map((e) => e.type)).toEqual(["task.created", "task.status_changed"]);
    expect(scenario.completed).toMatchObject({
      agentId: MEMBER,
      taskId: TASK,
      payload: { status: "completed" },
    });
    const live = await stage(scenario.state);
    let snapshot: ProjectState;
    try {
      expect(live.pip(MEMBER)?.userData.state).toBe("unknown");
      live.store.getState().applyEvent(scenario.completed);
      await vi.waitFor(() => expect(live.row()?.userData.state).toBe("completed"));
      const state = live.store.getState().state;
      expect(state?.tasks[TASK]).toMatchObject({
        completedByAgentId: MEMBER,
        assignedAgentIds: [],
      });
      expect.soft(live.pip(MEMBER)?.userData.state, "live actor pip").toBe("completed");
      expect(live.pip(OTHER)?.userData.state).toBe("unknown");
      if (!state) throw new Error("Missing completed state");
      snapshot = json(state);
    } finally {
      await live.screen.unmount();
    }
    // Both a completed snapshot and a checkpoint plus replay must work in a new
    // store and component, so a stream-only attribution cache cannot pass.
    for (const replayCompletion of [false, true]) {
      const restored = await stage(replayCompletion ? json(scenario.state) : snapshot);
      try {
        if (replayCompletion) restored.store.getState().applyEvent(json(scenario.completed));
        await vi.waitFor(() => expect(restored.row()?.userData.state).toBe("completed"));
        expect(restored.store.getState().state?.tasks[TASK]).toMatchObject({
          completedByAgentId: MEMBER,
          assignedAgentIds: [],
        });
        expect
          .soft(
            restored.pip(MEMBER)?.userData.state,
            replayCompletion ? "replayed actor pip" : "snapshot actor pip",
          )
          .toBe("completed");
        expect(restored.pip(OTHER)?.userData.state).toBe("unknown");
        restored.store.getState().applyEvent(scenario.status("queued"));
        await vi.waitFor(() => expect(restored.row()?.userData.state).toBe("pending"));
        expect(restored.store.getState().state?.tasks[TASK]).not.toHaveProperty(
          "completedByAgentId",
        );
        expect(restored.store.getState().state?.tasks[TASK]?.assignedAgentIds).toEqual([]);
        expect(restored.pip(MEMBER)?.userData.state).toBe("unknown");
        expect(restored.pip(OTHER)?.userData.state).toBe("unknown");
      } finally {
        await restored.screen.unmount();
      }
    }
  });

  it.each([false, true])(
    "leaves both member pips unknown for actorless completion (previous attribution: %s)",
    async (afterAttributed) => {
      const scenario = completionScenario();
      const s = await stage(scenario.state);
      try {
        if (afterAttributed) {
          s.store.getState().applyEvent(scenario.completed);
          await vi.waitFor(() => expect(s.row()?.userData.state).toBe("completed"));
          expect(s.store.getState().state?.tasks[TASK]?.completedByAgentId).toBe(MEMBER);
        }
        s.store.getState().applyEvent(scenario.status("completed"));
        await vi.waitFor(() => expect(s.row()?.userData.state).toBe("completed"));
        // Flush the store-driven render even when the queue status stays completed.
        await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
        expect(s.store.getState().state?.tasks[TASK]).not.toHaveProperty("completedByAgentId");
        expect(s.store.getState().state?.tasks[TASK]?.assignedAgentIds).toEqual([]);
        expect(s.pip(MEMBER)?.userData.state).toBe("unknown");
        expect(s.pip(OTHER)?.userData.state).toBe("unknown");
      } finally {
        await s.screen.unmount();
      }
    },
  );
});
