import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "../ui/HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "../ui/HistoryProvider.tsx";
import { GIT_LABEL, GIT_LOG } from "./archive-fixture.ts";
import { type ArchiveSpec, layeredEngine } from "./layered-engine.ts";

// M8.13 contract: while history is open, the provider re-reads the timeline list on an interval.
// `HistoryProvider` takes `refreshIntervalMs` (default 15000) so an archive that finishes after
// history was opened with only the live recording shows up in the picker without any focus.

function Composition() {
  const { store, mode } = useHistoryPresentation();
  const view = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <>
      <output aria-label="Presented recording">{`${mode}:${view.state?.head ?? 0}`}</output>
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

const picker = () => page.getByRole("combobox", { name: "Timeline", exact: true });

describe("timeline picker refresh", () => {
  it("appears and lists an archive that finishes after history was opened", async () => {
    const archives: ArchiveSpec[] = [];
    const engine = layeredEngine({ base: timelineEngine().fetcher, archives });
    vi.stubGlobal("fetch", engine.fetcher);
    selectProject(PROJECT);
    dataStore.getState().reset(PROJECT);
    dataStore.getState().applySnapshotState(stateAt(8));
    const view = await render(
      <SessionProvider value={SECRET}>
        <HistoryProvider refreshIntervalMs={200}>
          <Composition />
        </HistoryProvider>
      </SessionProvider>,
    );
    cleanups.push(() => view.unmount());
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect
      .poll(() => page.getByRole("status", { name: "Presented recording" }).element().textContent)
      .toBe("history:8");
    // Only the live recording exists: no picker yet.
    expect(picker().elements()).toHaveLength(0);

    archives.push({
      id: "archive:5b0c8f2e-3c1d-4a77-9a55-0d6f1e2a7b01",
      archiveKind: "git",
      label: GIT_LABEL,
      log: GIT_LOG,
    });

    await expect.element(picker(), { timeout: 3_000 }).toBeVisible();
    const names = picker()
      .getByRole("option")
      .elements()
      .map((option) => option.textContent ?? "");
    expect(names).toHaveLength(2);
    expect(names[0]).toMatch(/^Live recording/);
    expect(names[1]).toContain(GIT_LABEL);
    // The replay stays put while the list refreshes.
    expect(page.getByRole("status", { name: "Presented recording" }).element().textContent).toBe(
      "history:8",
    );
  });
});
