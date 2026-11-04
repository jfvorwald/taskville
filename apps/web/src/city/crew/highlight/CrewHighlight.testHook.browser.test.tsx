import { Canvas } from "@react-three/fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { PROJECT } from "../../../../test/data/fake-engine.ts";
import { createDataStore } from "../../../data/store.ts";
import { agent, stateOf, sub } from "../subagents/testScene.tsx";
import { CrewHighlight } from "./CrewHighlight.tsx";
import { createHighlightStore } from "./highlightStore.ts";

// M5.26 red (#348): the family highlight is drawn in WebGL with no observable state, so the crews
// e2e can only compare pixels. Behind VITE_TV_TEST_HOOKS=1, CrewHighlight exposes its state on
//
//   window.__taskvilleCrewHighlight: () => { parentId: string; familyIds: string[];
//                                            dimmedIds: string[] } | null
//
// (same style as window.__taskvilleMovement, installed in a useEffect guarded by the literal
// `import.meta.env.VITE_TV_TEST_HOOKS === "1"`, deleted on unmount). It returns the current
// highlightState: familyIds is the open agent then its children (highlightState().familyIds),
// dimmedIds every other agent in the store, sorted. It returns null while no Crew tab is open
// (state inactive). Without the flag the property is never defined.

interface Shown {
  parentId: string;
  familyIds: string[];
  dimmedIds: string[];
}
type Hook = (() => Shown | null) | undefined;
const hook = (): Hook =>
  (window as unknown as { __taskvilleCrewHighlight?: Hook }).__taskvilleCrewHighlight;

const FRAME = { timeout: 5000 };

function mount() {
  const store = createDataStore({ now: () => 0 });
  store.getState().reset(PROJECT);
  store
    .getState()
    .applySnapshotState(
      stateOf([
        agent("L", { kind: "lead" }),
        sub("c1", "L"),
        sub("c2", "L"),
        agent("o", { kind: "session" }),
      ]),
    );
  const inputs = createHighlightStore();
  render(
    <div style={{ width: 200, height: 150 }}>
      <Canvas orthographic camera={{ position: [10, 8, 10], zoom: 40 }}>
        <CrewHighlight store={store} inputs={inputs} />
      </Canvas>
    </div>,
  );
  return inputs;
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("crew highlight test hook", () => {
  it("exposes the family and the dimmed ids while a Crew tab is open, and clears on close", async () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "1");
    const inputs = mount();
    await vi.waitFor(() => expect(typeof hook()).toBe("function"), FRAME);
    expect(hook()?.()).toBeNull();

    inputs.open("L");
    await vi.waitFor(() => expect(hook()?.()).not.toBeNull(), FRAME);
    const shown = hook()?.();
    expect(shown?.parentId).toBe("L");
    expect([...(shown?.familyIds ?? [])].sort()).toEqual(["L", "c1", "c2"]);
    expect(shown?.dimmedIds).toEqual(["o"]);

    inputs.open(null);
    await vi.waitFor(() => expect(hook()?.()).toBeNull(), FRAME);
  });

  it("is not defined when test hooks are off", async () => {
    vi.stubEnv("VITE_TV_TEST_HOOKS", "");
    const inputs = mount();
    inputs.open("L");
    await new Promise((r) => setTimeout(r, 300));
    expect(hook()).toBeUndefined();
  });
});
