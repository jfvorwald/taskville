import { act, useSyncExternalStore } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AGENT, cardsEngine, PROJECT, SECRET } from "../../../test/history/ui/cards-fixture.ts";
import { selectionStore } from "../../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { worldAnchors } from "../../overlays/host/index.ts";
import { OverlayRoot } from "../../overlays/index.tsx";
import { SessionProvider } from "../../pairing/session.tsx";
import { themeController } from "../../themes/core/index.ts";
import { HistoryControls } from "../ui/HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "../ui/HistoryProvider.tsx";

function Composition() {
  const { store, mode, time } = useHistoryPresentation();
  const view = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <div style={{ position: "relative", width: 900, height: 600 }}>
      <output aria-label="Quip position">{`${mode}:${view.state?.head}:${time}`}</output>
      <OverlayRoot store={store} mode={mode} />
      <HistoryControls />
    </div>
  );
}
const cleanups: Array<() => Promise<void>> = [];
const originalTheme = themeController.store.getState();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  selectionStore.select(null);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
  worldAnchors.removeAnchor(`agent:${AGENT}`);
  worldAnchors.setProjection([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], {
    width: 0,
    height: 0,
  });
  themeController.setTheme(originalTheme.themeId);
  themeController.setHistory(originalTheme.history);
  themeController.setMode(originalTheme.mode);
});
function click(name: string) {
  act(() =>
    (page.getByRole("button", { name, exact: true }).element() as HTMLButtonElement).click(),
  );
}
const bubble = () =>
  document.querySelector<HTMLElement>(`[data-testid="quip-bubble"][data-agent-id="${AGENT}"]`);

it("mounted history presents the identical live quip and recorded tool fact despite different current attention/clock", async () => {
  const engine = cardsEngine();
  const recorded = engine.stateAt(3);
  const recordedTime = Date.parse(engine.log[2].receivedAt);
  expect(recorded.requests["recorded-request"].toolName).toBe("Read");
  expect(engine.current.requests["current-request"].toolName).toBe("Write");
  vi.stubGlobal("fetch", engine.fetcher);
  // Control only the existing store clock for the live baseline, never pickQuip or Bubbles.
  const clock = vi.spyOn(dataStore, "now").mockReturnValue(recordedTime);
  selectProject(PROJECT);
  selectionStore.select(null);
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Composition />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await expect.poll(() => dataStore.getState().connection).toBe("live");
  worldAnchors.setAnchor(`agent:${AGENT}`, [0, 0, 0]);
  worldAnchors.setProjection([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], {
    width: 900,
    height: 600,
  });
  expect(worldAnchors.project(`agent:${AGENT}`)?.visible).toBe(true);
  act(() => dataStore.getState().applySnapshotState(recorded));
  await expect.poll(() => bubble()?.textContent).toContain("Needs OK: Read");
  const liveText = bubble()?.textContent;
  expect(liveText?.length).toBeGreaterThan("Needs OK: Read".length);
  expect(getComputedStyle(bubble() as HTMLElement).visibility).toBe("visible");
  // Global current attention differs, but the recording remains the exact same event/agent/theme.
  act(() => dataStore.getState().applySnapshotState(engine.current));
  await expect.poll(() => bubble()?.textContent).toContain("Needs OK: Write");
  clock.mockReturnValue(recordedTime + 86_400_000);
  click("History");
  await expect
    .element(page.getByRole("status", { name: "Quip position" }))
    .toMatchTextContent("history:4:");
  click("Previous moment");
  await expect
    .element(page.getByRole("status", { name: "Quip position" }))
    .toHaveTextContent(`history:3:${recordedTime}`);
  expect(dataStore.getState().state).toEqual(engine.current);
  act(() => selectionStore.select(AGENT));
  // Preserve the already-composed read-only permission card contract; no command is invoked.
  await expect.element(page.getByTestId("action-card")).toHaveAttribute("data-readonly", "true");
  expect(page.getByTestId("action-card").element().querySelectorAll("button")).toHaveLength(0);
  await expect.poll(() => bubble()?.textContent).toBe(liveText);
  expect(getComputedStyle(bubble() as HTMLElement).visibility).toBe("visible");
  expect(engine.calls.every((call) => call.method === "GET")).toBe(true);
  expect(engine.calls.some((call) => call.url.pathname.includes("/commands"))).toBe(false);
});
