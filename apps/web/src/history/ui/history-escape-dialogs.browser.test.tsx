import { useState } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "./HistoryProvider.tsx";

// M6.09 round 2: the history Escape handler stops Escape in the capture phase, so it must keep
// the app's dialog and text-entry rule (city/interaction/escape.ts): Escape inside a dialog
// belongs to the dialog, and Escape in a text field does not leave history.
//
// Intended RED today: the dialog case (the handler exits history and the dialog never sees the
// key). The text input and unmount cases are guards that may pass today.

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

const dialogSeen: string[] = [];

function Shell() {
  const history = useHistoryPresentation();
  const [controls, setControls] = useState(true);
  return (
    <>
      {controls ? <HistoryControls /> : null}
      <button type="button" onClick={() => setControls(false)}>
        Remove controls
      </button>
      <output aria-label="Mode">{history.mode}</output>
      <div
        role="dialog"
        aria-label="Probe dialog"
        onKeyDown={(event) => dialogSeen.push(event.key)}
      >
        <button type="button">Inside dialog</button>
      </div>
      <input aria-label="Probe text" type="text" />
    </>
  );
}

async function mountInHistory() {
  dialogSeen.length = 0;
  const transport = timelineEngine();
  vi.stubGlobal("fetch", transport.fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(stateAt(2));
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Shell />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.element(mode()).toHaveTextContent("history");
}

const mode = () => page.getByRole("status", { name: "Mode" });
const stillHistory = () => new Promise((r) => setTimeout(r, 400));

describe("Escape in history mode respects dialogs and text fields (M6.09)", () => {
  it("lets a dialog keep its Escape: the dialog sees it and history does not exit", async () => {
    await mountInHistory();
    (page.getByRole("button", { name: "Inside dialog" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Escape}");
    await stillHistory();
    expect(dialogSeen).toContain("Escape");
    await expect.element(mode()).toHaveTextContent("history");
  });

  it("guard: Escape in a text input does not leave history", async () => {
    await mountInHistory();
    (page.getByRole("textbox", { name: "Probe text" }).element() as HTMLElement).focus();
    await userEvent.keyboard("{Escape}");
    await stillHistory();
    await expect.element(mode()).toHaveTextContent("history");
  });

  it("guard: after HistoryControls unmounts, Escape does nothing to history", async () => {
    await mountInHistory();
    await page.getByRole("button", { name: "Remove controls" }).click();
    expect(page.getByRole("button", { name: "History", exact: true }).elements()).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await stillHistory();
    await expect.element(mode()).toHaveTextContent("history");
  });
});
