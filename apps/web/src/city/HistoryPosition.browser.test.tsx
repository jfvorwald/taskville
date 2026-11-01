import { Canvas, type RootState } from "@react-three/fiber";
import { act } from "react";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { eventBuilder, PROJECT } from "../../test/data/fake-engine.ts";
import { initialState, reduce } from "../data/domain.ts";
import { createDataStore } from "../data/store.ts";
import { CityRoot } from "./index.tsx";

describe("historical city positions with identical recorded times", () => {
  it("removes the later recorded agent immediately when seeking to the earlier state", async () => {
    const at = "2026-10-30T10:00:00.000Z";
    const emit = eventBuilder();
    const earlier = reduce(initialState(PROJECT), {
      ...emit("agent.registered", "kept"),
      occurredAt: at,
      receivedAt: at,
    });
    const later = reduce(earlier, {
      ...emit("agent.registered", "removed"),
      occurredAt: at,
      receivedAt: at,
    });
    const store = createDataStore({ now: () => Date.parse(at) });
    store.getState().reset(PROJECT);
    store.getState().applySnapshotState(later);
    let root: RootState | undefined;
    const view = await render(
      <div style={{ width: 240, height: 180 }}>
        <Canvas
          frameloop="never"
          onCreated={(state) => {
            root = state;
          }}
        >
          <CityRoot store={store} mode="history" historyTime={Date.parse(at)} />
        </Canvas>
      </div>,
    );
    try {
      const drawn = () =>
        root?.scene.children
          .filter((object) => object.visible && typeof object.userData.agentId === "string")
          .map((object) => object.userData.agentId as string) ?? [];
      await vi.waitFor(() => expect(drawn()).toContain("removed"), { timeout: 10_000 });
      await act(async () => store.getState().applySnapshotState(earlier));
      // A seek publishes the recorded scene immediately, without a live departure animation.
      // No frame advancement can accidentally finish that animation for the obsolete agent.
      await vi.waitFor(() => expect(drawn()).not.toContain("removed"));
      expect(drawn()).toContain("kept");
    } finally {
      await view.unmount();
    }
  });
});
