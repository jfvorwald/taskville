import { act, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  AGENT,
  cardsEngine,
  EXACT,
  PREVIEW,
  PROJECT,
  SECRET,
} from "../../../test/history/ui/cards-fixture.ts";
import { selectionStore } from "../../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { OverlayRoot } from "../../overlays/index.tsx";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "./HistoryProvider.tsx";

// Only SceneRoot's DOM composition seam is reproduced. No replacement card, panel, host,
// registry, renderTab, future component import, or invented production API is supplied.
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
async function mount(resolution?: "expired" | "answered_elsewhere") {
  const engine = cardsEngine(resolution);
  // Validate prerequisites before interpreting a missing DOM card as red.
  expect(engine.stateAt(2).requests["recorded-request"]).toBeUndefined();
  expect(engine.stateAt(3).requests["recorded-request"]).toMatchObject({
    state: "open",
    inputPreview: PREVIEW,
    sessionId: "recorded-session",
  });
  expect(engine.stateAt(4).requests["recorded-request"].state).toBe(resolution ?? "expired");
  expect(engine.current.requests["current-request"]).toMatchObject({
    state: "open",
    toolName: "Write",
    answerable: true,
  });
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
  await position(6, "live");
  await expect.poll(() => dataStore.getState().connection).toBe("live");
  // Use the real H shortcut: this canvas-free harness has no scene layout.
  await userEvent.keyboard("h");
  await position(4);
  const historyStart = engine.calls.length;
  act(() => selectionStore.select(AGENT));
  expect(selectionStore.getSnapshot()).toBe(AGENT);
  return { ...engine, historyStart };
}
const card = () => page.getByTestId("action-card");
async function recordedCard() {
  await expect.poll(() => card().elements().length).toBe(1);
  await expect.element(card()).toBeVisible();
  await expect.element(card()).toHaveAttribute("data-readonly", "true");
  for (const fact of ["Recorded Ada", PROJECT, "recorded-session", "Read", PREVIEW])
    await expect.element(card()).toMatchTextContent(fact);
  // Scope command exclusions to the card; presentation navigation elsewhere is allowed.
  expect(card().element().querySelectorAll("button, textarea, input")).toHaveLength(0);
  expect(card().element().textContent).not.toContain(EXACT);
  expect(card().element().textContent).not.toContain("current-session");
  expect(card().element().textContent).not.toContain("Current Ada");
}
function noLiveReads(engine: ReturnType<typeof cardsEngine>, since: number) {
  const calls = engine.calls.slice(since);
  expect(calls.filter(({ method }) => method !== "GET")).toEqual([]);
  expect(
    calls.filter(({ url }) =>
      /\/requests\/.*\/input|\/agents\/.*\/(feed|files)|\/evidence(?:\/|$)/.test(url.pathname),
    ),
  ).toEqual([]);
}
async function previous(head: number) {
  await page.getByRole("button", { name: "Previous moment" }).click();
  await position(head);
}

describe("historical sidebar composition through real provider, controls and OverlayRoot", () => {
  it("shows recorded open permission facts instead of the same agent's current request, without live reads or commands", async () => {
    const engine = await mount();
    const since = engine.historyStart;
    await previous(3);
    expect(dataStore.getState().state).toEqual(engine.current);
    await recordedCard();
    noLiveReads(engine, since);
  });

  it("rewinding before opening removes the future card and keeps a read-only recorded agent shell", async () => {
    const engine = await mount();
    await previous(3);
    const since = engine.historyStart;
    await previous(2);
    expect(selectionStore.getSnapshot()).toBe(AGENT);
    expect(card().elements()).toHaveLength(0);
    const panel = page.getByTestId("agent-panel");
    await expect.poll(() => panel.elements().length).toBe(1);
    await expect.element(panel).toHaveAttribute("data-readonly", "true");
    await expect.element(page.getByTestId("agent-panel-name")).toHaveTextContent("Recorded Ada");
    expect(panel.element().textContent).not.toContain(PREVIEW);
    const files = page.getByRole("tab", { name: "Files", exact: true });
    if (files.elements().length) await files.click();
    noLiveReads(engine, since);
  });

  it.each(["expired", "answered_elsewhere"] as const)(
    "fresh selection at a recorded %s request still exposes final facts read-only",
    async (resolution) => {
      const engine = await mount(resolution);
      const since = engine.historyStart;
      // Selected only after arrival at the final position; no open card was ever mounted.
      await recordedCard();
      await expect.element(card()).toHaveAttribute("data-state", resolution);
      noLiveReads(engine, since);
      await previous(3);
      await recordedCard();
      await page.getByRole("button", { name: "Next moment" }).click();
      await position(4);
      await recordedCard();
      await expect.element(card()).toHaveAttribute("data-state", resolution);
    },
  );

  it("returning live restores only the latest current request and its ordinary held-input actions", async () => {
    const engine = await mount();
    await previous(3);
    await recordedCard();
    noLiveReads(engine, engine.historyStart);
    const since = engine.calls.length;
    await userEvent.keyboard("l");
    await position(6, "live");
    await expect.element(card()).toMatchTextContent("Current Ada");
    await expect.element(card()).toMatchTextContent("current-session");
    await expect.element(card()).toMatchTextContent(EXACT);
    expect(card().element().textContent).not.toContain(PREVIEW);
    expect(card().element().getAttribute("data-readonly")).not.toBe("true");
    for (const name of ["Allow once", "Deny", "Open session"]) {
      expect(
        [...card().element().querySelectorAll("button")].some(
          (button) => button.textContent?.trim() === name,
        ),
      ).toBe(true);
    }
    const calls = engine.calls.slice(since);
    expect(
      calls
        .filter(({ url }) => url.pathname.includes("/input"))
        .map(({ url }) => `${url.pathname}${url.search}`),
    ).toEqual([`/v1/requests/current-request/input?projectId=${PROJECT}`]);
    expect(engine.calls.filter(({ method }) => method !== "GET")).toEqual([]);
    // Inspect controls only: no decision, editor or session action is invoked.
  });

  it("clears recorded cards on deselection and project exit without leaking the old request", async () => {
    const engine = await mount();
    await previous(3);
    await recordedCard();
    const since = engine.historyStart;
    act(() => selectionStore.select(null));
    await expect.poll(() => card().elements().length).toBe(0);
    act(() => selectionStore.select(AGENT));
    await recordedCard();
    act(() => selectProject("another-project"));
    await expect.poll(() => selectionStore.getSnapshot()).toBeNull();
    await expect.poll(() => card().elements().length).toBe(0);
    expect(page.getByTestId("agent-panel").elements()).toHaveLength(0);
    expect(page.getByTestId("overlay-root").element().textContent).not.toContain(PREVIEW);
    noLiveReads(engine, since);
  });
});
