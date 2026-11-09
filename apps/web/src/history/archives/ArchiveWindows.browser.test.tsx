import { act, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "../ui/HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "../ui/HistoryProvider.tsx";
import { WINDOW_EVENTS } from "./archive-timelines.ts";
import { COUNT, occurred, scaleEngine } from "./scale-fixture.ts";

// M8.13 review fixes. A long archive holds one window of events at a time. Contract:
// - a far seek whose state read fails leaves strip, slider, chip and city on the previous
//   position and window (the new window is not left displayed beside the old city);
// - Previous moment and Next moment stay enabled at a window boundary when events exist beyond
//   it, and pressing one loads that window and lands on the neighbouring event.

function Composition() {
  const { store, mode } = useHistoryPresentation();
  const view = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <>
      <output aria-label="Presented head">{`${mode}:${view.state?.head ?? 0}`}</output>
      <HistoryControls />
    </>
  );
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

const head = () => page.getByRole("status", { name: "Presented head" }).element().textContent;
const slider = () =>
  page.getByRole("slider", { name: "Timeline time" }).element() as HTMLInputElement;
const chip = () => page.getByText(/^HISTORY\s*·/).element().textContent ?? "";
const button = (name: string) =>
  page.getByRole("button", { name, exact: true }).element() as HTMLButtonElement;
const firstMarkerLabel = () =>
  document.querySelector("[data-marker]")?.getAttribute("aria-label") ?? "";

function setSlider(value: number) {
  act(() => {
    const input = slider();
    const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
    set?.call(input, String(value));
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}

async function open() {
  const transport = scaleEngine();
  vi.stubGlobal("fetch", transport.fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Composition />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(head, { timeout: 30_000 }).toBe(`history:${COUNT}`);
  return transport;
}

describe("a failed far seek in a long archive", () => {
  it("leaves the strip, slider, chip and city on the previous window and position", async () => {
    const transport = await open();
    const stripBefore = firstMarkerLabel();
    expect(stripBefore).not.toBe("");
    const chipBefore = chip();
    expect(chipBefore).toContain(new Date(occurred(COUNT)).toLocaleString());

    transport.control.failState = true;
    setSlider(1);
    await expect.element(page.getByText("Could not load recorded state.")).toBeVisible();

    // The city never moved, so nothing else may claim it did.
    expect(head()).toBe(`history:${COUNT}`);
    expect(slider().value).toBe(String(COUNT));
    expect(chip()).toBe(chipBefore);
    // The strip shows the window around the city, not the one that failed to load.
    expect(firstMarkerLabel()).toBe(stripBefore);
  });
});

describe("moment navigation across windows", () => {
  it("keeps Previous moment enabled at the first event of a window and loads the window before", async () => {
    await open();
    // Open at the newest window's first event: its first marker seeks there.
    const firstLabel = firstMarkerLabel();
    (document.querySelector("[data-marker]") as HTMLButtonElement).click();
    await expect.poll(head).toBe(`history:${COUNT - WINDOW_EVENTS + 1}`);
    expect(firstMarkerLabel()).toBe(firstLabel);
    expect(button("Previous moment").disabled).toBe(false);

    act(() => button("Previous moment").click());
    await expect.poll(head).toBe(`history:${COUNT - WINDOW_EVENTS}`);
    expect(slider().value).toBe(String(COUNT - WINDOW_EVENTS));
    expect(chip()).toContain(new Date(occurred(COUNT - WINDOW_EVENTS)).toLocaleString());
  });

  it("keeps Next moment enabled at the last event of a window and loads the window after", async () => {
    await open();
    setSlider(1);
    await expect.poll(head).toBe("history:1");
    // The window now holds the oldest events; step to its last one.
    setSlider(WINDOW_EVENTS);
    await expect.poll(head).toBe(`history:${WINDOW_EVENTS}`);
    expect(button("Next moment").disabled).toBe(false);

    act(() => button("Next moment").click());
    await expect.poll(head).toBe(`history:${WINDOW_EVENTS + 1}`);
    expect(slider().value).toBe(String(WINDOW_EVENTS + 1));
    expect(chip()).toContain(new Date(occurred(WINDOW_EVENTS + 1)).toLocaleString());
  });
});
