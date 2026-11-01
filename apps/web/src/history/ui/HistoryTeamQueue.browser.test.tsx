import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  EARLY,
  LATE,
  LIVE_ONLY,
  PROJECT,
  SECRET,
  TEAM,
  teamEngine,
} from "../../../test/history/ui/team-fixture.ts";
import { dispatchQueue } from "../../city/crew/teams/queue.ts";
import { selectionStore } from "../../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { OverlayRoot } from "../../overlays/index.tsx";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "./HistoryProvider.tsx";

// Only SceneRoot's DOM composition seam is reproduced (as in HistoryCards): the real provider,
// controls and OverlayRoot, so the sidebar agent list is the one the app mounts.
function Composition() {
  const { store, mode } = useHistoryPresentation();
  const view = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <>
      <output aria-label="Selected recording">
        {mode}:{view.state?.head ?? 0}
      </output>
      <OverlayRoot store={store} mode={mode} />
      <HistoryControls />
    </>
  );
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  selectProject(DEFAULT_PROJECT_ID);
  selectionStore.select(null);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
});
async function position(head: number, mode = "history") {
  await expect
    .element(page.getByRole("status", { name: "Selected recording" }))
    .toHaveTextContent(`${mode}:${head}`);
}
async function mount() {
  const engine = teamEngine();
  // Prerequisites: the fixture really differs by head, so a missing row is never a fixture fault.
  const titles = (state: ReturnType<typeof engine.stateAt>) =>
    dispatchQueue(state, TEAM).map((task) => task.title);
  expect(titles(engine.stateAt(3))).toEqual([EARLY]);
  expect(titles(engine.stateAt(4))).toEqual([EARLY, LATE]);
  expect(titles(engine.current)).toEqual([EARLY, LATE, LIVE_ONLY]);
  selectProject(PROJECT);
  selectionStore.select(null);
  vi.stubGlobal("fetch", engine.fetcher);
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Composition />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await position(5, "live");
  await expect.poll(() => dataStore.getState().connection).toBe("live");
  await expect.element(task(LIVE_ONLY)).toBeVisible();
  await userEvent.keyboard("h");
  await position(4);
  return engine;
}
const task = (title: string) => page.getByText(title, { exact: true });
// The canvas-free harness lays the queue over the controls, so press them without hit testing.
const press = (name: string) =>
  (page.getByRole("button", { name, exact: true }).element() as HTMLButtonElement).click();

describe("team task queue in the sidebar agent list follows the replay head", () => {
  it("shows only tasks recorded at the head, never the live store's future task", async () => {
    await mount();
    await expect.element(task(EARLY)).toBeVisible();
    await expect.element(task(LATE)).toBeVisible();
    await expect.poll(() => task(LIVE_ONLY).elements().length).toBe(0);
  });

  it("drops a task created after the selected head and brings it back going forward", async () => {
    await mount();
    press("Previous moment");
    await position(3);
    await expect.element(task(EARLY)).toBeVisible();
    await expect.poll(() => task(LATE).elements().length).toBe(0);
    expect(task(LIVE_ONLY).elements()).toHaveLength(0);
    press("Next moment");
    await position(4);
    await expect.element(task(LATE)).toBeVisible();
    expect(task(LIVE_ONLY).elements()).toHaveLength(0);
  });

  it("returning to live shows the current tasks again", async () => {
    await mount();
    press("Previous moment");
    await position(3);
    await expect.poll(() => task(LATE).elements().length).toBe(0);
    await userEvent.keyboard("l");
    await position(5, "live");
    for (const title of [EARLY, LATE, LIVE_ONLY]) await expect.element(task(title)).toBeVisible();
  });
});
