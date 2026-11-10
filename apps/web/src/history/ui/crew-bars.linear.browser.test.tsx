import { afterEach, describe, expect, it, vi } from "vitest";
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

// Work seam: every registration fold goes through the domain's applyRegistration (however the
// module is reached, the mock is keyed by the resolved file). `copied` adds up the size of the
// agents map each fold was handed, which is what `put` copies per write: it grows as N squared
// when one shared entities state is folded, and stays flat when each agent folds its own.
const work = vi.hoisted(() => ({ folds: 0, copied: 0, crewRuns: 0, barRenders: 0 }));
// CrewBars reads `styles.crew` once per render that reaches its markup, so this counts bar renders.
vi.mock("./crew-bars.module.css", () => ({
  default: new Proxy(
    {},
    {
      get: (_target, key) => {
        if (key === "crew") work.barRenders += 1;
        return String(key);
      },
    },
  ),
}));
vi.mock("../../../../../packages/domain/src/reducer/index.ts", async (importOriginal) => {
  const original =
    await importOriginal<typeof import("../../../../../packages/domain/src/reducer/index.ts")>();
  return {
    ...original,
    applyRegistration: (...args: Parameters<typeof original.applyRegistration>) => {
      work.folds += 1;
      work.copied += Object.keys(args[0].agents).length;
      return original.applyRegistration(...args);
    },
  };
});
vi.mock("./crew-bars.tsx", async (importOriginal) => {
  const original = await importOriginal<typeof import("./crew-bars.tsx")>();
  return {
    ...original,
    crewRuns: (...args: Parameters<typeof original.crewRuns>) => {
      work.crewRuns += 1;
      return original.crewRuns(...args);
    },
  };
});

const { crewRuns } = await vi.importActual<typeof import("./crew-bars.tsx")>("./crew-bars.tsx");

function longRecording(subagents: number) {
  return recording([
    registered("p1", "Planner", { kind: "session" }),
    ...Array.from({ length: subagents }, (_, i) =>
      registered(`c${i}`, `worker-${i}`, { kind: "subagent", parentAgentId: "p1" }),
    ),
    ...Array.from({ length: subagents }, (_, i) => finished(`c${subagents - 1 - i}`)),
  ]);
}

function measure(subagents: number) {
  const events = longRecording(subagents);
  work.folds = 0;
  work.copied = 0;
  const runs = crewRuns(events);
  return { runs, folds: work.folds, copied: work.copied, events: events.length };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
  work.crewRuns = 0;
  work.barRenders = 0;
});

describe("crewRuns is linear in the number of events (M6.16)", () => {
  it("folds each registration once and copies no more per write when the recording doubles", () => {
    const small = measure(1000);
    const large = measure(2000);
    expect(small.runs).toHaveLength(1000);
    expect(large.runs).toHaveLength(2000);
    expect(small.folds).toBe(1001); // non-vacuous: the seam saw every registration
    expect(large.folds).toBe(2001);
    // Linear work at most doubles (allow 2.5x); a shared state copied per write quadruples it.
    expect(large.copied).toBeLessThanOrEqual(Math.max(1, small.copied) * 2.5);
  });
});

describe("crew bars are memoized (M6.16)", () => {
  it("a playhead tick neither recomputes crewRuns nor re-renders the bars", async () => {
    const log = recording([
      registered("p1", "Planner", { kind: "session" }),
      registered("c1", "reviewer-one", { kind: "subagent", parentAgentId: "p1" }),
      registered("c2", "reviewer-two", { kind: "subagent", parentAgentId: "p1" }),
      finished("c1"),
      finished("c2"),
    ]);
    vi.stubGlobal("fetch", timelineEngine(log).fetcher);
    selectProject(PROJECT);
    dataStore.getState().reset(PROJECT);
    dataStore.getState().applySnapshotState(stateAt(log.length, log));
    const view = await render(
      <SessionProvider value={SECRET}>
        <HistoryProvider>
          <HistoryControls />
        </HistoryProvider>
      </SessionProvider>,
    );
    cleanups.push(() => view.unmount());
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect.element(page.getByRole("img", { name: /reviewer-one/ })).toBeInTheDocument();

    expect(work.barRenders).toBeGreaterThan(0); // non-vacuous: the bars did render
    const rendersBefore = work.barRenders;
    const runsBefore = work.crewRuns;
    const slider = page.getByRole("slider", { name: "Timeline time" });
    for (const key of ["Home", "End", "Home", "End"] as const) {
      (slider.element() as HTMLInputElement).focus();
      await userEvent.keyboard(`{${key}}`);
    }
    await expect.element(page.getByRole("img", { name: /reviewer-one/ })).toBeInTheDocument();
    expect(work.crewRuns).toBe(runsBefore);
    expect(work.barRenders).toBe(rendersBefore);
  });
});
