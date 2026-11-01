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
// "answered": the agent is selected in live, its request is denied here and the card shows
// "Sent, unconfirmed" before history is entered. "unanswered": selected and left open.
// "pending": the request is denied here but the engine's reply is held until released.
type LiveCard = "answered" | "unanswered" | "pending";
async function mount(
  resolution?: "expired" | "answered_elsewhere",
  heuristic = false,
  liveCard?: LiveCard,
) {
  const engine = cardsEngine(resolution, heuristic);
  // Validate prerequisites before interpreting a missing DOM card as red.
  expect(engine.stateAt(2).requests["recorded-request"]).toBeUndefined();
  expect(engine.stateAt(3).requests["recorded-request"]).toMatchObject({
    state: "open",
    inputPreview: PREVIEW,
    sessionId: "recorded-session",
  });
  expect(engine.stateAt(3).requests["recorded-request"].heuristic).toBe(
    heuristic ? true : undefined,
  );
  expect(engine.stateAt(4).requests["recorded-request"].state).toBe(resolution ?? "expired");
  expect(engine.current.requests["current-request"]).toMatchObject({
    state: "open",
    toolName: "Write",
    answerable: true,
  });
  selectProject(PROJECT);
  selectionStore.select(null);
  const posts: string[] = [];
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  // Only the live decision POST is answered here, and only when a live card is exercised; any
  // other write still reaches the engine fixture, which refuses it and records it.
  const fetcher: typeof fetch =
    liveCard === undefined
      ? engine.fetcher
      : async (input, init) => {
          const url = new URL(String(input), location.origin);
          if (url.pathname === "/v1/commands" && init?.method === "POST") {
            posts.push(String(init.body));
            if (liveCard === "pending") await gate;
            return Response.json({
              command: { id: "c1", type: "permission.decide", status: "delivered" },
            });
          }
          return engine.fetcher(input, init);
        };
  vi.stubGlobal("fetch", fetcher);
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
  if (liveCard !== undefined) {
    act(() => selectionStore.select(AGENT));
    await expect.element(card()).toMatchTextContent("Current Ada");
    await expect.element(card()).toMatchTextContent(EXACT);
    if (liveCard === "pending") {
      await page.getByRole("button", { name: "Deny", exact: true }).click();
      await expect.poll(() => posts.length).toBe(1);
      await expect.element(card()).not.toHaveAttribute("data-state", "sent");
    }
    if (liveCard === "answered") {
      await page.getByRole("button", { name: "Deny", exact: true }).click();
      await expect.element(card()).toHaveAttribute("data-state", "sent");
      await expect.element(card()).toMatchTextContent(/sent, unconfirmed/i);
      expect(posts).toHaveLength(1);
      // The engine then records the request as answered here and it leaves attention; the card
      // is kept (final state) until the selection changes.
      const current = dataStore.getState().state as unknown as {
        requests: Record<string, Record<string, unknown>>;
      };
      act(() =>
        dataStore.setState({
          attention: [],
          state: {
            ...current,
            requests: {
              ...current.requests,
              "current-request": { ...current.requests["current-request"], state: "answered_here" },
            },
          } as never,
        }),
      );
      await expect.element(card()).toMatchTextContent(/sent, unconfirmed/i);
    }
  }
  // Use the real H shortcut: this canvas-free harness has no scene layout.
  await userEvent.keyboard("h");
  await position(4);
  const historyStart = engine.calls.length;
  if (liveCard === undefined) act(() => selectionStore.select(AGENT));
  expect(selectionStore.getSnapshot()).toBe(AGENT);
  return { ...engine, historyStart, posts, release };
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

  it("labels a recorded request the source attributed by guess 'Possibly needs you'", async () => {
    const engine = await mount(undefined, true);
    await previous(3);
    await recordedCard();
    await expect.element(card()).toMatchTextContent("Possibly needs you");
    noLiveReads(engine, engine.historyStart);
  });

  it("does not call an observed recorded request a guess", async () => {
    await mount();
    await previous(3);
    await recordedCard();
    expect(card().element().textContent).not.toMatch(/possibly/i);
  });

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

  it("a live card answered here is back for the same selection after a trip through history, offering no decision", async () => {
    const engine = await mount(undefined, false, "answered");
    const since = engine.historyStart;
    // In history only the recorded facts for the replay head show, never the kept live target.
    await recordedCard();
    expect(card().element().textContent).not.toMatch(/sent, unconfirmed/i);
    expect(card().element().getAttribute("data-state")).not.toBe("sent");
    await previous(3);
    await recordedCard();
    expect(card().element().textContent).not.toMatch(/sent, unconfirmed/i);
    noLiveReads(engine, since);
    // Back to live: a card for the same selection and request is shown again, not answerable.
    await userEvent.keyboard("l");
    await position(6, "live");
    expect(selectionStore.getSnapshot()).toBe(AGENT);
    await expect.poll(() => card().elements().length).toBe(1);
    await expect.element(card()).toMatchTextContent("Current Ada");
    await expect.element(card()).toMatchTextContent("current-session");
    expect(card().element().getAttribute("data-readonly")).not.toBe("true");
    const enabled = [...card().element().querySelectorAll("button")]
      .filter((button) => !button.disabled)
      .map((button) => button.textContent?.trim());
    expect(enabled).not.toContain("Allow once");
    expect(enabled).not.toContain("Deny");
    // The one decision was sent in live before history; none was sent or repeated since.
    expect(engine.posts).toHaveLength(1);
    expect(engine.calls.filter(({ method }) => method !== "GET")).toEqual([]);
  });

  it("a live card answered here still says 'Sent, unconfirmed' after a trip through history (#116 D4)", async () => {
    await mount(undefined, false, "answered");
    await previous(3);
    await recordedCard();
    await userEvent.keyboard("l");
    await position(6, "live");
    await expect.poll(() => card().elements().length).toBe(1);
    await expect.element(card()).toHaveAttribute("data-state", "sent");
    await expect.element(card()).toMatchTextContent(/sent, unconfirmed/i);
  });

  it("an answer that lands during a recording is kept: the live card says 'Sent, unconfirmed' and no second POST is sent", async () => {
    const engine = await mount(undefined, false, "pending");
    // The decision is in flight and the user is now in history, where the live card is gone.
    await recordedCard();
    expect(engine.posts).toHaveLength(1);
    // The engine's delivered reply arrives only now, while the recording replaces the card.
    engine.release();
    await new Promise((resolve) => setTimeout(resolve, 100));
    await recordedCard();
    expect(card().element().textContent).not.toMatch(/sent, unconfirmed/i);
    await userEvent.keyboard("l");
    await position(6, "live");
    await expect.poll(() => card().elements().length).toBe(1);
    await expect.element(card()).toHaveAttribute("data-state", "sent");
    await expect.element(card()).toMatchTextContent(/sent, unconfirmed/i);
    expect(engine.posts).toHaveLength(1);
  });

  it("captions the read-only input box 'Recorded preview' so it is not mistaken for the exact input", async () => {
    await mount();
    await previous(3);
    await recordedCard();
    // A visible caption on the card, outside the preview itself.
    await expect.element(card()).toMatchTextContent("Recorded preview");
    const box = page.getByTestId("action-card-input").element();
    expect(box.textContent).toBe(PREVIEW);
    expect(box.textContent).not.toContain("Recorded preview");
  });

  it("keeps the live card's input caption: no 'Recorded preview' on the live card", async () => {
    await mount(undefined, false, "unanswered");
    await userEvent.keyboard("l");
    await position(6, "live");
    await expect.element(card()).toMatchTextContent("Current Ada");
    await expect.element(card()).toMatchTextContent(EXACT);
    expect(card().element().textContent).not.toMatch(/recorded preview/i);
  });

  it.each(["answered", "unanswered"] as const)(
    "the kept live target (%s) never renders decision buttons or asks for the exact input in history",
    async (liveCard) => {
      const engine = await mount(undefined, false, liveCard);
      const since = engine.historyStart;
      const root = () => page.getByTestId("overlay-root").element();
      const decisions = () =>
        [...root().querySelectorAll("button")]
          .map((button) => button.textContent?.trim())
          .filter((name) => name === "Allow once" || name === "Deny");
      // At the final head, at the recorded open request, and before it was ever opened (no
      // recorded card at all, where a kept live target could most easily leak through).
      for (const head of [4, 3, 2]) {
        if (head < 4) await previous(head);
        expect(decisions()).toEqual([]);
        expect(root().textContent).not.toMatch(/sent, unconfirmed/i);
        expect(root().textContent).not.toContain(EXACT);
        expect(root().textContent).not.toContain("current-session");
        expect(card().elements().length).toBe(head === 2 ? 0 : 1);
      }
      await expect.poll(() => page.getByTestId("agent-panel").elements().length).toBe(1);
      expect(decisions()).toEqual([]);
      const reads = engine.calls
        .slice(since)
        .filter(({ url }) => /\/requests\/[^/]+\/input/.test(url.pathname));
      expect(reads).toEqual([]);
      noLiveReads(engine, since);
    },
  );
});
