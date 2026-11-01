import { Canvas } from "@react-three/fiber";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import type { AgentView } from "../agents/index.ts";
import { AgentsLayer } from "../agents/index.ts";
import { createCameraRig } from "./cameraRig.ts";
import { InteractionLayer } from "./InteractionLayer.tsx";
import { createSelectionStore } from "./selection.ts";

function agent(id: string, x: number): AgentView {
  return {
    id,
    kind: "session",
    displayName: id,
    activity: "idle",
    placement: { x, y: 0, z: 0, heading: 0 },
  };
}

const store = createSelectionStore();
const rig = createCameraRig();

function City({ agents }: { agents: readonly AgentView[] }) {
  return (
    <div style={{ width: 300, height: 200 }}>
      <Canvas camera={{ position: [0, 3, 6], fov: 40 }}>
        <ambientLight />
        <InteractionLayer store={store} rig={rig} reducedMotion />
        <AgentsLayer agents={agents} reducedMotion />
      </Canvas>
    </div>
  );
}

describe("InteractionLayer selection of an agent that leaves the city", () => {
  it("keeps the selection while the agent is there, and clears it once the agent is gone", async () => {
    const both = [agent("a1", -1), agent("a2", 1)];
    const screen = await render(<City agents={both} />);

    store.select("a1");
    // Give the frame loop time to find the agent (it rescans every half second).
    await new Promise((r) => setTimeout(r, 1200));
    expect(store.getSnapshot()).toBe("a1");

    // The agent is removed from the city. After the next rescan the selection is cleared.
    await screen.rerender(<City agents={[agent("a2", 1)]} />);
    await vi.waitFor(() => expect(store.getSnapshot()).toBeNull(), { timeout: 3000 });
  });

  it("waits for an agent that has not mounted yet instead of clearing the selection", async () => {
    store.select(null);
    const screen = await render(<City agents={[agent("a2", 1)]} />);
    store.select("late");
    await new Promise((r) => setTimeout(r, 1500));
    expect(store.getSnapshot()).toBe("late");
    await screen.rerender(<City agents={[agent("a2", 1), agent("late", -1)]} />);
    await new Promise((r) => setTimeout(r, 1200));
    expect(store.getSnapshot()).toBe("late");
  });
});
