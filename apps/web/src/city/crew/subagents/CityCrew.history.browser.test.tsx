import { Canvas, type RootState } from "@react-three/fiber";
import { type Object3D, Vector3 } from "three";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { initialState } from "../../../data/domain.ts";
import { createDataStore } from "../../../data/store.ts";
import { worldAnchors } from "../../../overlays/host/index.ts";
import { getSettingsStore } from "../../../overlays/settings/store.ts";
import { CityRoot } from "../../index.tsx";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import { LEAD, sub, T } from "./testScene.tsx";

// Real production city mounting over a paused recorded store, not a reduced-motion fixture.
it.each(["history", "live"] as const)(
  "keeps a running crew at its %s presentation position with a frozen store clock",
  async (mode) => {
    const settings = getSettingsStore();
    const previous = settings.getSnapshot().reducedMotion;
    settings.set("reducedMotion", "off");
    const project = "paused-crew";
    const now = Date.parse(T) + 60_000;
    const store = createDataStore({ now: () => now });
    const at = (head: number) => ({
      ...initialState(project),
      head,
      agents: { lead: LEAD, kid: sub("kid", "lead") },
    });
    store.getState().reset(project);
    store.getState().applySnapshotState(at(1));
    let root: RootState | undefined;
    let unmount: (() => Promise<void>) | undefined;
    try {
      const view = await render(
        <div style={{ width: 320, height: 240 }}>
          <Canvas
            onCreated={(state) => {
              root = state;
            }}
          >
            <CityRoot store={store} mode={mode} />
          </Canvas>
        </div>,
      );
      unmount = () => view.unmount();
      const radius = () => {
        let bot: Object3D | undefined;
        root?.scene.traverse((object) => {
          if (object.userData.agentId === "kid") bot = object;
        });
        if (!bot) throw new Error("Crew bot not mounted");
        for (let parent: Object3D | null = bot; parent; parent = parent.parent) {
          if (!parent.visible) throw new Error("Crew bot hidden");
        }
        const anchor = worldAnchors.getAnchor(agentAnchorId("lead"));
        if (!anchor) throw new Error("Parent anchor absent");
        const position = bot.getWorldPosition(new Vector3());
        return Math.hypot(position.x - anchor[0], position.z - anchor[2]);
      };
      const expected = mode === "history" ? 1.5 : 0.7;
      await vi.waitFor(() => expect(radius()).toBeCloseTo(expected, 4), { timeout: 10_000 });
      for (const head of [2, 1]) {
        store.getState().applySnapshotState(at(head));
        await vi.waitFor(() => expect(radius()).toBeCloseTo(expected, 4), { timeout: 10_000 });
        expect(store.now()).toBe(now);
      }
      expect(settings.getSnapshot().reducedMotion).toBe("off");
    } finally {
      await unmount?.();
      settings.set("reducedMotion", previous);
    }
  },
  30_000,
);
