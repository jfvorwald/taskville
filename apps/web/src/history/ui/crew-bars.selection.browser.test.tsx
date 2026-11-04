import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { finished, recording, registered } from "./crew-bars.fixture.ts";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider } from "./HistoryProvider.tsx";

// Two unrelated families: Planner -> reviewer-one, Auditor -> reviewer-two.
const LOG = recording([
  registered("p1", "Planner", { kind: "session" }),
  registered("p2", "Auditor", { kind: "session" }),
  registered("c1", "reviewer-one", { kind: "subagent", parentAgentId: "p1" }),
  registered("c2", "reviewer-two", { kind: "subagent", parentAgentId: "p2" }),
  finished("c1"),
  finished("c2"),
]);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});
const bars = () => page.getByRole("img", { name: /reviewer-/ });
const names = () =>
  bars()
    .elements()
    .map((el) => el.getAttribute("aria-label") ?? "");
async function chooseAgent(name: string) {
  await page
    .getByRole("combobox", { name: /agent/i })
    .selectOptions(page.getByRole("option", { name, exact: true }));
}

it("shows only runs whose parent or child is the selected agent", async () => {
  vi.stubGlobal("fetch", timelineEngine(LOG).fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(stateAt(LOG.length, LOG));
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <HistoryControls />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await page.getByRole("button", { name: "History", exact: true }).click();

  await expect.poll(() => names().length).toBe(2); // all agents: both families
  await chooseAgent("Planner");
  await expect.poll(() => names().length).toBe(1);
  expect(names()[0]).toMatch(/reviewer-one/);
  await chooseAgent("reviewer-two"); // the child is selected: its own run stays
  await expect.poll(() => names().length).toBe(1);
  expect(names()[0]).toMatch(/reviewer-two/);
  await chooseAgent("All agents");
  await expect.poll(() => names().length).toBe(2);
});
