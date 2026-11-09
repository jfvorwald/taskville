import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import {
  initialState,
  projectStateHash,
  REDUCER_VERSION,
  snapshotResponseSchema,
} from "../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "../ui/HistoryControls.tsx";
import { HistoryProvider } from "../ui/HistoryProvider.tsx";

// M8.13 contract, scale. An archive of 200,000 events (one git commit a minute, so every event
// is a marker candidate) must not put 200,000 nodes in the strip, and must not load all 1,000
// pages up front. The strip keeps the first and last day. Events come from a generator, one
// page at a time; nothing is parsed or rendered here beyond what the provider asks for.

const COUNT = 200_000;
const PAGE = 200;
const T0 = Date.parse("2026-01-01T00:00:00Z");
const MINUTE = 60_000;
const ID = "archive:3d9e5b70-8c21-4a6f-b7d4-1e0f2a3b4c55";
const sha = "e".repeat(40);

const occurred = (sequence: number) => new Date(T0 + (sequence - 1) * MINUTE).toISOString();

const event = (sequence: number) => ({
  schemaVersion: 1,
  projectId: PROJECT,
  sourceId: "import-scale",
  sourceEventId: `scale-${sequence}`,
  eventId: `00000000-0000-4000-8400-${String(sequence).padStart(12, "0")}`,
  ingestSequence: sequence,
  receivedAt: "2026-11-08T09:00:00Z",
  evidenceIds: [],
  provenance: "imported",
  late: false,
  type: "git.commit",
  occurredAt: occurred(sequence),
  payload: { repo: "taskville", sha, parents: [], subject: `commit ${sequence}` },
});

function engine() {
  const pages = { count: 0 };
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input), location.origin);
    const path = decodeURIComponent(url.pathname);
    if (path === `/v1/projects/${PROJECT}/timelines`) {
      return Response.json({
        projectId: PROJECT,
        timelines: [
          {
            id: ID,
            kind: "archive",
            archiveKind: "git",
            label: "Huge repo",
            projectId: PROJECT,
            firstSequence: 1,
            lastSequence: COUNT,
            firstAt: occurred(1),
            lastAt: occurred(COUNT),
            eventCount: COUNT,
          },
        ],
      });
    }
    if (path === `/v1/timelines/${ID}/events`) {
      pages.count += 1;
      const cursor = url.searchParams.get("cursor");
      const from = cursor
        ? Number(cursor.slice(1))
        : Math.max(1, Number(url.searchParams.get("from") ?? 1));
      const to = Math.min(COUNT, Number(url.searchParams.get("to") ?? COUNT));
      const last = Math.min(to, from + PAGE - 1);
      const events = [];
      for (let sequence = from; sequence <= last; sequence += 1) events.push(event(sequence));
      return Response.json({
        timelineId: ID,
        events,
        nextCursor: last < to ? `c${last + 1}` : null,
      });
    }
    // State: only the head matters to the strip, so skip replaying 200,000 reductions.
    const raw = url.searchParams.get("at") ?? "";
    const at = /^\d+$/.test(raw)
      ? Math.min(Number(raw), COUNT)
      : Math.min(COUNT, Math.max(0, Math.floor((Date.parse(raw) - T0) / MINUTE) + 1));
    const state = { ...initialState(PROJECT), head: at };
    const snapshot = snapshotResponseSchema.parse({
      projectId: PROJECT,
      cursor: at,
      reducerVersion: REDUCER_VERSION,
      stateHash: projectStateHash(state),
      state,
      attention: [],
      computedAt: "2026-11-08T12:00:00Z",
    });
    const { projectId: _projectId, ...wire } = snapshot;
    return Response.json({ timelineId: ID, at, ...wire });
  };
  return { fetcher, pages };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

describe("a 200,000 event archive", () => {
  it("keeps the strip bounded, lists the first and last day, and loads events lazily", async () => {
    const transport = engine();
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
