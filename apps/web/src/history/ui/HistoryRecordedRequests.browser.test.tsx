import { act, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import {
  ADA,
  BEA,
  LIVE_ONLY,
  PROJECT,
  requestsEngine,
  SECRET,
  type Spec,
} from "../../../test/history/ui/recorded-requests-fixture.ts";
import { selectionStore } from "../../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { OverlayRoot } from "../../overlays/index.tsx";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "./HistoryProvider.tsx";

// Same composition seam as HistoryCards.browser.test.tsx: the real provider, controls and
// OverlayRoot, with a canvas-free harness. No replacement card, panel or host is supplied.
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
/** Mounts live, then enters history with the real H shortcut; the head is the last event. */
async function mount(specs: readonly Spec[], liveOnlyAgent = false) {
  const engine = requestsEngine(specs, liveOnlyAgent);
  expect(engine.stateAt(specs.length).head).toBe(specs.length);
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
  await position(liveOnlyAgent ? specs.length + 1 : specs.length, "live");
  await expect.poll(() => dataStore.getState().connection).toBe("live");
  await userEvent.keyboard("h");
  await position(specs.length);
  return engine;
}
const card = () => page.getByTestId("action-card");
const panel = () => page.getByTestId("agent-panel");
const settings = () => page.getByRole("button", { name: "Settings", exact: true });
const root = () => page.getByTestId("overlay-root");
async function previous(head: number) {
  await page.getByRole("button", { name: "Previous moment" }).click();
  await position(head);
}
function select(agentId: string | null) {
  act(() => selectionStore.select(agentId));
}
async function showsCard(preview: string, tool: string, agent: string) {
  await expect.poll(() => card().elements().length).toBe(1);
  await expect.element(card()).toHaveAttribute("data-readonly", "true");
  await expect.element(card()).toMatchTextContent(agent);
  await expect.element(card()).toMatchTextContent(tool);
  await expect.element(page.getByTestId("action-card-input")).toHaveTextContent(preview);
}
async function showsNoCard() {
  await expect.poll(() => card().elements().length).toBe(0);
}

const registered = (agentId: string): Spec => ({ type: "agent.registered", agentId });
const opened = (agentId: string, requestId: string, toolName: string, preview: string): Spec => ({
  type: "request.opened",
  agentId,
  requestId,
  toolName,
  preview,
});

describe("a late request.opened never becomes the recorded target", () => {
  it("keeps the earlier non-late request as the card when a late one is recorded after it", async () => {
    const engine = await mount([
      registered(ADA),
      opened(ADA, "r-open", "Read", "Early open preview"),
      { ...opened(ADA, "r-late", "Write", "Late spooled preview"), late: true },
    ]);
    // The replayed state does hold the late request (expired); only the target must ignore it.
    expect(engine.stateAt(3).requests["r-late"]).toMatchObject({ late: true, state: "expired" });
    select(ADA);
    await showsCard("Early open preview", "Read", "Recorded Ada");
    expect(card().element().textContent).not.toContain("Late spooled preview");
    expect(card().element().textContent).not.toContain("Write");
  });

  it("shows the agent panel, not a card, when the only recorded request is a late one", async () => {
    await mount([
      registered(ADA),
      { ...opened(ADA, "r-late", "Write", "Late spooled preview"), late: true },
    ]);
    select(ADA);
    await expect.poll(() => panel().elements().length).toBe(1);
    await showsNoCard();
    expect(root().element().textContent).not.toContain("Late spooled preview");
  });
});

describe("the recorded target is the most recent request for the selected agent at the head", () => {
  const SPECS: Spec[] = [
    registered(ADA),
    registered(BEA),
    opened(ADA, "a-first", "Read", "Ada first preview"),
    opened(BEA, "b-only", "Bash", "Bea only preview"),
    opened(ADA, "a-second", "Write", "Ada second preview"),
  ];

  it("picks the later of two requests, then the earlier one after rewinding between them", async () => {
    await mount(SPECS);
    select(ADA);
    await showsCard("Ada second preview", "Write", "Recorded Ada");
    // Head 4: Bea's request is the most recent opened one, and it is not Ada's.
    await previous(4);
    await showsCard("Ada first preview", "Read", "Recorded Ada");
    expect(card().element().textContent).not.toContain("Bea only preview");
    expect(card().element().textContent).not.toContain("Ada second preview");
    await previous(3);
    await showsCard("Ada first preview", "Read", "Recorded Ada");
    // Before any request opened there is no card for Ada.
    await previous(2);
    await showsNoCard();
    await expect.poll(() => panel().elements().length).toBe(1);
  });

  it("never gives one agent another agent's open request", async () => {
    await mount(SPECS);
    select(BEA);
    await showsCard("Bea only preview", "Bash", "Recorded Bea");
    expect(card().element().textContent).not.toContain("Ada");
    // At head 3 only Ada's first request exists; Bea has none yet.
    await previous(4);
    await previous(3);
    await showsNoCard();
    await expect.poll(() => panel().elements().length).toBe(1);
    expect(root().element().textContent).not.toContain("Ada first preview");
  });
});

describe("the recorded input preview renders escaped", () => {
  const MARKUP = "<img src=x onerror=alert(1)>";
  // BEL, a right-to-left override and a zero-width space.
  const PREVIEW = `${MARKUP} \u0007 ‮ after ​ end`;
  const SHOWN = `${MARKUP} <U+0007> <U+202E> after <U+200B> end`;

  it("shows markup as text with no element created, and control or bidi characters as markers", async () => {
    const alert = vi.fn();
    vi.stubGlobal("alert", alert);
    await mount([registered(ADA), opened(ADA, "r-markup", "Read", PREVIEW)]);
    select(ADA);
    await expect.poll(() => card().elements().length).toBe(1);
    const box = page.getByTestId("action-card-input");
    await expect.element(box).toHaveTextContent(SHOWN);
    expect(box.element().textContent).toBe(SHOWN);
    expect(box.element().children).toHaveLength(0);
    expect(root().element().querySelector("img")).toBeNull();
    for (const hidden of ["\u0007", "‮", "​"])
      expect(card().element().textContent).not.toContain(hidden);
    expect(alert).not.toHaveBeenCalled();
  });
});

describe("the sidebar falls back to settings in history", () => {
  const SPECS: Spec[] = [registered(ADA), opened(ADA, "r-ada", "Read", "Ada preview")];

  it("shows the settings panel when nothing is selected", async () => {
    await mount(SPECS);
    expect(selectionStore.getSnapshot()).toBeNull();
    await expect.element(settings()).toBeVisible();
    await showsNoCard();
    expect(panel().elements()).toHaveLength(0);
  });

  it("shows the settings panel for an agent the replay does not know", async () => {
    await mount(SPECS, true);
    // The live store knows this agent; the replayed state at the head does not.
    expect(dataStore.getState().state?.agents[LIVE_ONLY]).toBeDefined();
    select(LIVE_ONLY);
    expect(selectionStore.getSnapshot()).toBe(LIVE_ONLY);
    await expect.element(settings()).toBeVisible();
    await showsNoCard();
    expect(panel().elements()).toHaveLength(0);
  });

  it("shows the settings panel for an id that exists nowhere", async () => {
    await mount(SPECS);
    select("agent-ghost");
    await expect.element(settings()).toBeVisible();
    await showsNoCard();
    expect(panel().elements()).toHaveLength(0);
  });
});
