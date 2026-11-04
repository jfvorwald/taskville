import { Canvas } from "@react-three/fiber";
import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { AgentsLayer } from "../../city/agents/index.ts";
import { createCameraRig } from "../../city/interaction/cameraRig.ts";
import { InteractionLayer } from "../../city/interaction/InteractionLayer.tsx";
import { selectionStore } from "../../city/interaction/selection.ts";
import { useSelection } from "../../city/interaction/useSelection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { AgentPanel } from "../../overlays/agent-panel/shell/AgentPanel.tsx";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "./HistoryProvider.tsx";

// M6.09 (#311): Escape in history mode returns to live and keeps the selection and the open
// panel. Real composition: the real history controls, the real agent panel and the real city
// InteractionLayer all listen on the window, as in the app.
//
// Intended RED today: the history handler exits to live, but the panel's and the city's Escape
// listeners also run and clear the selection (a1), so the panel closes.

const rig = createCameraRig();
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  selectionStore.select(null);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

function Shell() {
  const history = useHistoryPresentation();
  const selection = useSelection();
  const mode = useSyncExternalStore(
    history.store.subscribe,
    () => history.mode,
    () => history.mode,
  );
  return (
    <>
      <output aria-label="Mode">{mode}</output>
      <output aria-label="Selected">{selection.selectedId ?? "none"}</output>
      <div style={{ width: 300, height: 200 }}>
        <Canvas camera={{ position: [0, 3, 6], fov: 40 }}>
          <ambientLight />
          <InteractionLayer store={selectionStore} rig={rig} reducedMotion />
          <AgentsLayer
            agents={[
              {
                id: "a1",
                kind: "session",
                displayName: "Ada",
                activity: "idle",
                placement: { x: 0, y: 0, z: 0, heading: 0 },
              },
            ]}
            reducedMotion
          />
        </Canvas>
      </div>
      <AgentPanel
        mode={history.mode === "history" ? "history" : "live"}
        selection={selection}
        store={dataStore}
      />
    </>
  );
}

async function mount() {
  const transport = timelineEngine();
  vi.stubGlobal("fetch", transport.fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(stateAt(2));
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Shell />
        <HistoryControls />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
}

const mode = () => page.getByRole("status", { name: "Mode" });
const selected = () => page.getByRole("status", { name: "Selected" });
const panel = () => page.getByTestId("agent-panel");

async function selectAda() {
  selectionStore.select("a1");
  await expect.element(selected()).toHaveTextContent("a1");
  await expect.element(panel()).toBeVisible();
}
async function enterHistory() {
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.element(mode()).toHaveTextContent("history");
}
// The city rescans for the selected agent every half second; let it settle before pressing.
const settle = () => new Promise((r) => setTimeout(r, 900));

describe("Escape in history mode (M6.09)", () => {
  it("returns to live and keeps the agent selected with the panel open", async () => {
    await mount();
    await selectAda();
    await enterHistory(); // the history listener registers last: the worst order for the bug
    await settle();
    await userEvent.keyboard("{Escape}");
    await expect.element(mode()).toHaveTextContent("live");
    expect(selectionStore.getSnapshot()).toBe("a1");
    await expect.element(selected()).toHaveTextContent("a1");
    await expect.element(panel()).toBeVisible();
  });

  it("does the same when focus is inside the panel", async () => {
    await mount();
    await selectAda();
    await enterHistory(); // the history listener registers last: the worst order for the bug
    await settle();
    const tab = page.getByRole("tab", { name: "Files" });
    (tab.element() as HTMLElement).focus();
    expect(panel().element().contains(document.activeElement)).toBe(true);
    await userEvent.keyboard("{Escape}");
    await expect.element(mode()).toHaveTextContent("live");
    expect(selectionStore.getSnapshot()).toBe("a1");
    await expect.element(panel()).toBeVisible();
  });

  it("guard: in live mode Escape still clears the selection and closes the panel", async () => {
    await mount();
    await selectAda();
    await settle();
    await userEvent.keyboard("{Escape}");
    await expect.element(selected()).toHaveTextContent("none");
    expect(panel().elements()).toHaveLength(0);
    await expect.element(mode()).toHaveTextContent("live");
  });
});
