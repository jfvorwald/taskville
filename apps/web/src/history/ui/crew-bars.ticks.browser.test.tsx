import { afterEach, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { finished, recording, registered } from "./crew-bars.fixture.ts";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider } from "./HistoryProvider.tsx";

// Every render of CrewBars records the `runs` array it was given. A timeline that refilters the
// crew on each sequence tick hands it a fresh array each time, so identity is the (clock-free)
// witness that the filtering was not recomputed.
const seen = vi.hoisted(() => [] as unknown[]);
vi.mock("./crew-bars.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./crew-bars.tsx")>();
  return {
    ...original,
    CrewBars: (props: Parameters<typeof original.CrewBars>[0]) => {
      seen.push(props.runs);
      return original.CrewBars(props);
    },
  };
});

const LOG = recording([
  registered("p1", "Planner", { kind: "session" }),
  registered("c1", "reviewer-one", { kind: "subagent", parentAgentId: "p1" }),
  registered("c2", "reviewer-two", { kind: "subagent", parentAgentId: "p1" }),
  finished("c1"),
  finished("c2"),
]);

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
  seen.length = 0;
});

it("does not recompute crew filtering on sequence ticks when recording and selection are unchanged", async () => {
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
  await expect.element(page.getByRole("img", { name: /reviewer-one/ })).toBeVisible();

  const slider = page.getByRole("slider", { name: "Timeline time" });
  const rendersBefore = seen.length;
  for (const key of ["Home", "End", "Home", "End"] as const) {
    (slider.element() as HTMLInputElement).focus();
    await userEvent.keyboard(`{${key}}`);
  }
  await expect.poll(() => seen.length).toBeGreaterThan(rendersBefore); // ticks did re-render
  expect(new Set(seen).size).toBe(1); // ...with the same filtered array every time
});
