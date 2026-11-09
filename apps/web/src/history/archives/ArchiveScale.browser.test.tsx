import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "../ui/HistoryControls.tsx";
import { HistoryProvider } from "../ui/HistoryProvider.tsx";
import { COUNT, occurred, scaleEngine } from "./scale-fixture.ts";

// M8.13 contract, scale. An archive of 200,000 events (one git commit a minute, so every event
// is a marker candidate) must not put 200,000 nodes in the strip, and must not load all 1,000
// pages up front. The strip keeps the first and last day. Events come from a generator, one
// page at a time; nothing is parsed or rendered here beyond what the provider asks for.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

describe("a 200,000 event archive", () => {
  it("keeps the strip bounded, lists the first and last day, and loads events lazily", async () => {
    const transport = scaleEngine();
    vi.stubGlobal("fetch", transport.fetcher);
    selectProject(PROJECT);
    dataStore.getState().reset(PROJECT);
    const view = await render(
      <SessionProvider value={SECRET}>
        <HistoryProvider>
          <HistoryControls />
        </HistoryProvider>
      </SessionProvider>,
    );
    cleanups.push(() => view.unmount());
    await page.getByRole("button", { name: "History", exact: true }).click();
    const slider = page.getByRole("slider", { name: "Timeline time" });
    await expect.element(slider, { timeout: 60_000 }).toBeVisible();

    const strip = (slider.element() as HTMLElement).parentElement as HTMLElement;
    const nodes = strip.querySelectorAll("[data-marker], span").length;
    expect(nodes).toBeLessThan(2_000);

    for (const iso of [occurred(1), occurred(COUNT)])
      await expect
        .element(page.getByText(new Date(iso).toLocaleDateString(), { exact: true }).first())
        .toBeVisible();

    // Not the whole archive up front: 200,000 events are 1,000 pages.
    expect(transport.pages.count).toBeLessThanOrEqual(100);
  }, 120_000);
});
