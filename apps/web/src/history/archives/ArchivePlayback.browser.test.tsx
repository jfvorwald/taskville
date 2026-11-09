import { act, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { storedEnvelopeSchemas } from "../../../../../packages/protocol/src/index.ts";
import { eventBuilder, PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import {
  initialState,
  projectStateHash,
  REDUCER_VERSION,
  reduce,
  snapshotResponseSchema,
} from "../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "../ui/HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "../ui/HistoryProvider.tsx";
import { type ArchiveSpec, archiveEvents, layeredEngine } from "./layered-engine.ts";

// M8.13 contract, archive playback. Gaps longer than 10 minutes between archive events play as
// 2 seconds, so 600x reaches the last event of an archive with a 30 day hole within a few
// seconds of wall time. The strip shows an element with `data-gap` (aria-label matching /gap/i)
// at each compressed gap, and none for ordinary gaps. Live recordings keep real-speed scale.

const T0 = Date.parse("2026-02-01T10:00:00Z");
const MINUTE = 60_000;
const DAY = 24 * 60 * MINUTE;
const ARCHIVE_ID = "archive:7a1c2e90-4b3d-4f55-9a10-3c2b1d0e9f01";
const LIVE = `live:${PROJECT}`;

const commit = (at: number, letter: string) => ({
  type: "git.commit",
  occurredAt: new Date(at).toISOString(),
  payload: {
    repo: "taskville",
    sha: letter.repeat(40),
    parents: [],
    subject: `commit ${letter}`,
  },
});

function archive(): ArchiveSpec {
  return {
    id: ARCHIVE_ID,
    archiveKind: "git",
    label: "Gappy repo",
    log: archiveEvents("gappy", [
      commit(T0, "a"),
      commit(T0 + MINUTE, "b"),
      commit(T0 + MINUTE + 30 * DAY, "c"),
    ]),
  };
}

/** A live recording whose three events are received at the given offsets from T0. */
function liveEngine(offsets: number[]) {
  const emit = eventBuilder();
  const log = offsets.map((offset, index) =>
    storedEnvelopeSchemas["agent.registered"].parse({
      ...emit("agent.registered", `recorded-${index + 1}`),
      receivedAt: new Date(T0 + offset).toISOString(),
    }),
  );
  const stateAt = (position: number) =>
    log.slice(0, position).reduce(reduce, initialState(PROJECT));
  const fetcher: typeof fetch = async (input) => {
    const url = new URL(String(input), location.origin);
    const path = decodeURIComponent(url.pathname);
    if (path === `/v1/projects/${PROJECT}/timelines`) {
      return Response.json({
        projectId: PROJECT,
        timelines: [
          {
            id: LIVE,
            kind: "live",
            projectId: PROJECT,
            firstSequence: 1,
            lastSequence: log.length,
            eventCount: log.length,
            firstAt: log[0]?.receivedAt,
            lastAt: log.at(-1)?.receivedAt,
          },
        ],
      });
    }
    const position = (raw: string) =>
      /^\d+$/.test(raw)
        ? Math.min(Number(raw), log.length)
        : (log.filter((event) => Date.parse(event.receivedAt) <= Date.parse(raw)).at(-1)
            ?.ingestSequence ?? 0);
    if (path === `/v1/timelines/${LIVE}/events`) {
      return Response.json({ timelineId: LIVE, events: log, nextCursor: null });
    }
    const state = stateAt(position(url.searchParams.get("at") ?? ""));
    const snapshot = snapshotResponseSchema.parse({
      projectId: PROJECT,
      cursor: state.head,
      reducerVersion: REDUCER_VERSION,
      stateHash: projectStateHash(state),
      state,
      attention: [],
      computedAt: "2026-11-08T12:00:00Z",
    });
    const { projectId: _projectId, ...wire } = snapshot;
    return Response.json({ timelineId: LIVE, at: state.head, ...wire });
  };
  return fetcher;
}

function Head() {
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
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

const head = () => page.getByRole("status", { name: "Presented head" }).element().textContent;
const gaps = () => [...document.querySelectorAll("[data-gap]")];

async function openAtStart(fetcher: typeof fetch) {
  vi.stubGlobal("fetch", fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Head />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(head).toBe("history:3");
  (page.getByRole("slider", { name: "Timeline time" }).element() as HTMLInputElement).focus();
  await userEvent.keyboard("{Home}");
  await expect.poll(head).toBe("history:1");
}

async function playAt600(wallMs: number) {
  vi.useFakeTimers();
  vi.setSystemTime(T0);
  act(() => {
    const select = page
      .getByRole("combobox", { name: "Playback speed" })
      .element() as HTMLSelectElement;
    const option = [...select.options].find((item) => item.textContent === "600x");
    select.value = option?.value ?? "";
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
  act(() => {
    (
      page.getByRole("button", { name: "Play", exact: true }).element() as HTMLButtonElement
    ).click();
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(wallMs);
  });
}

describe("archive playback gap compression", () => {
  it("reaches the last event of an archive with a 30 day gap within a few seconds at 600x", async () => {
    await openAtStart(layeredEngine({ archives: [archive()] }).fetcher);
    await playAt600(5_000);
    expect(head()).toBe("history:3");
  });

  it("marks only the compressed gap in the strip", async () => {
    await openAtStart(layeredEngine({ archives: [archive()] }).fetcher);
    const marks = gaps();
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute("aria-label") ?? "").toMatch(/gap/i);
  });

  it("leaves a live recording at real speed scale, with no gap marker", async () => {
    await openAtStart(liveEngine([0, MINUTE, MINUTE + 30 * DAY]));
    expect(gaps()).toHaveLength(0);
    await playAt600(5_000);
    // The one minute gap passes at 600x; the 30 day gap is nowhere near done after 5 s.
    expect(head()).toBe("history:2");
  });
});
