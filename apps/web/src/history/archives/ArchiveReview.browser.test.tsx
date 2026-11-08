import { act, useEffect, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { AGENT, cardsEngine } from "../../../test/history/ui/cards-fixture.ts";
import { stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { selectionStore } from "../../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { OverlayRoot } from "../../overlays/index.tsx";
import { SessionProvider } from "../../pairing/session.tsx";
import { themeController } from "../../themes/core/index.ts";
import { HistoryControls } from "../ui/HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "../ui/HistoryProvider.tsx";
import {
  GIT_ARCHIVE,
  GIT_LABEL,
  GIT_LOG,
  TRANSCRIPT_ARCHIVE,
  TRANSCRIPT_LOG,
} from "./archive-fixture.ts";
import { type ArchiveSpec, archiveEvents, layeredEngine, stateOf } from "./layered-engine.ts";

// M8.03 review round. Encoded contract on top of ArchiveTimelines.browser.test.tsx:
// - crew bars on an archive are placed and timed by occurredAt;
// - any failed switch (listing, events, state) or a no-longer-listed choice returns to live with
//   an error in role="status" and the theme history flag cleared;
// - the Timeline picker is never disabled while a switch is pending (aria-busy="true" instead),
//   keeps its element and keyboard focus, and re-fetches the list when it receives focus;
// - a project with archives and no live events opens its newest archive (latest lastAt) and still
//   shows the picker (even for one archive);
// - a long archive label is ellipsized (title carries the full label) and the header stays inside
//   a 900 px viewport;
// - no non-GET request is ever sent while an archive is open, and an archived permission request
//   shows no Allow or Deny;
// - a delayed state response for an archive left behind is dropped.

const seen: Array<{ mode: string; agents: string[] }> = [];
function Composition({ overlays = false }: { overlays?: boolean }) {
  const { store, mode } = useHistoryPresentation();
  const view = useSyncExternalStore(store.subscribe, store.getState);
  const agents = Object.keys(view.state?.agents ?? {});
  // biome-ignore lint/correctness/useExhaustiveDependencies: agents is a new array each render; the joined ids are the real dependency.
  useEffect(() => {
    seen.push({ mode, agents });
  }, [mode, agents.join(",")]);
  return (
    <>
      <div data-testid="presented">{JSON.stringify({ mode, state: view.state })}</div>
      {overlays ? <OverlayRoot store={store} mode={mode} /> : null}
      <HistoryControls />
    </>
  );
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  seen.length = 0;
  selectionStore.select(null);
  themeController.setHistory(false);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
  await page.viewport(414, 896);
});

const read = () =>
  JSON.parse(page.getByTestId("presented").element().textContent ?? "null") as {
    mode: string;
    state: ReturnType<typeof stateOf> | null;
  };
const picker = () => page.getByRole("combobox", { name: "Timeline", exact: true });
const historyButton = () => page.getByRole("button", { name: "History", exact: true });
const errorStatus = () => page.getByRole("status");
const listing = (url: URL) =>
  decodeURIComponent(url.pathname) === `/v1/projects/${PROJECT}/timelines`;
const route = (id: string, leaf: "events" | "state") => (url: URL) =>
  decodeURIComponent(url.pathname) === `/v1/timelines/${id}/${leaf}`;

function archive(
  id: string,
  archiveKind: ArchiveSpec["archiveKind"],
  label: string,
  log: ArchiveSpec["log"],
): ArchiveSpec {
  return { id, archiveKind, label, log };
}
const GIT = archive(GIT_ARCHIVE, "git", GIT_LABEL, GIT_LOG);
const TRANSCRIPTS = archive(
  TRANSCRIPT_ARCHIVE,
  "transcripts",
  "Claude Code transcripts",
  TRANSCRIPT_LOG,
);

async function mount(engineOptions: { archives: ArchiveSpec[]; live?: boolean }) {
  const live = engineOptions.live ?? true;
  const engine = layeredEngine({
    archives: engineOptions.archives,
    ...(live ? { base: timelineEngine().fetcher } : {}),
  });
  vi.stubGlobal("fetch", engine.fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  if (live) dataStore.getState().applySnapshotState(stateAt(8));
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Composition />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  return engine;
}
async function enterHistory(engine: ReturnType<typeof layeredEngine>) {
  await historyButton().click();
  await expect.poll(() => read().mode).toBe("history");
  expect(engine.calls.every(({ method }) => method === "GET")).toBe(true);
}
async function open(archiveId: string, label: string, head: number, log: ArchiveSpec["log"]) {
  await picker().selectOptions(page.getByRole("option", { name: new RegExp(label) }));
  await expect.poll(() => read().state?.head).toBe(head);
  expect(read().state).toEqual(stateOf(log, head));
  expect(archiveId).toMatch(/^archive:/);
}
/** Changes the picker the way a user can with a stale list: no focus, no refresh first. */
function forceChoose(id: string) {
  const select = picker().element() as HTMLSelectElement;
  const set = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")?.set;
  act(() => {
    set?.call(select, id);
    select.dispatchEvent(new Event("change", { bubbles: true }));
  });
}

// 1. Crew bars on archives -------------------------------------------------------------------
const CREW = archive(
  "archive:3c2f7a10-5d44-4e0a-9b61-aa00b7c9d101",
  "transcripts",
  "Crew transcripts",
  archiveEvents("crew", [
    {
      type: "agent.registered",
      agentId: "lead",
      occurredAt: "2026-02-10T09:00:00Z",
      payload: { sourceAgentId: "source-lead", displayName: "Lead", role: "dev", kind: "session" },
    },
    {
      type: "agent.registered",
      agentId: "scout",
      occurredAt: "2026-02-10T09:01:00Z",
      payload: {
        sourceAgentId: "source-scout",
        displayName: "Scout",
        role: "dev",
        kind: "subagent",
        parentAgentId: "lead",
      },
    },
    {
      type: "agent.finished",
      agentId: "scout",
      occurredAt: "2026-02-10T09:04:00Z",
      payload: { summary: "done" },
    },
  ]),
);

describe("crew bars on an archive", () => {
  it("place and time a subagent run by occurredAt, not by the import time", async () => {
    const engine = await mount({ archives: [CREW] });
    await enterHistory(engine);
    await open(CREW.id, "Crew transcripts", 3, CREW.log);
    const bar = page.getByRole("img", { name: /^Scout\b/ });
    await expect.element(bar).toBeVisible();
    const label = bar.element().getAttribute("aria-label") ?? "";
    expect(label).toContain(new Date("2026-02-10T09:01:00Z").toLocaleString());
    expect(label).toContain("ran 180s");
    expect(label).not.toContain(new Date("2026-11-08T09:00:00Z").toLocaleString());
    expect(label).not.toContain("ran 0s");
  });
});

// 2. Failed switches and stale choices return to live ----------------------------------------
describe("a switch that cannot complete", () => {
  const cases: Array<[string, (id: string) => (url: URL) => boolean]> = [
    ["the timeline list fails", () => listing],
    ["the archive events fail", (id) => route(id, "events")],
    ["the archive state fails", (id) => route(id, "state")],
  ];
  it.each(cases)("returns to live with the theme flag cleared when %s", async (_name, match) => {
    const engine = await mount({ archives: [GIT] });
    await enterHistory(engine);
    expect(themeController.store.getState().history).toBe(true);
    engine.fail(match(GIT_ARCHIVE));
    forceChoose(GIT_ARCHIVE);
    await expect.poll(() => read().mode).toBe("live");
    expect(read().state).toEqual(stateAt(8));
    expect(themeController.store.getState().history).toBe(false);
    await expect.poll(() => errorStatus().element().textContent).toMatch(/could not load/i);
    expect(page.getByRole("slider", { name: "Timeline time" }).elements()).toHaveLength(0);
    expect(picker().elements()).toHaveLength(0);
  });

  it("returns to live with an error when the chosen timeline is no longer listed", async () => {
    const engine = await mount({ archives: [GIT, TRANSCRIPTS] });
    await enterHistory(engine);
    engine.archives.splice(engine.archives.indexOf(GIT), 1); // removed after the list was read
    forceChoose(GIT_ARCHIVE);
    await expect.poll(() => read().mode).toBe("live");
    expect(themeController.store.getState().history).toBe(false);
    await expect.poll(() => errorStatus().element().textContent).toMatch(/\S/);
    expect(page.getByRole("slider", { name: "Timeline time" }).elements()).toHaveLength(0);
  });
});

// 3 and 4. Picker focus, busy state and refresh ----------------------------------------------
describe("timeline picker while history is open", () => {
  it("keeps its element and keyboard focus during a switch, busy but never disabled", async () => {
    const engine = await mount({ archives: [GIT] });
    await enterHistory(engine);
    const before = picker().element() as HTMLSelectElement;
    before.focus();
    await expect.element(picker()).toHaveFocus();
    const release = engine.hold(route(GIT_ARCHIVE, "state"));
    forceChoose(GIT_ARCHIVE);
    await expect.element(picker()).toHaveAttribute("aria-busy", "true");
    expect(picker().element().hasAttribute("disabled")).toBe(false);
    expect(document.activeElement).toBe(before);
    release();
    await expect.poll(() => read().state?.head).toBe(GIT_LOG.length);
    expect(picker().element()).toBe(before);
    expect(document.activeElement).toBe(before);
    expect(picker().element().getAttribute("aria-busy")).not.toBe("true");
  });

  it("lists an archive that finished while history was open once the picker is focused", async () => {
    const engine = await mount({ archives: [GIT] });
    await enterHistory(engine);
    const options = () =>
      picker()
        .getByRole("option")
        .elements()
        .map((option) => option.textContent ?? "");
    expect(options()).toHaveLength(2);
    engine.archives.push(TRANSCRIPTS);
    const lists = engine.calls.filter(({ url }) => listing(url)).length;
    (picker().element() as HTMLElement).focus();
    await expect.poll(() => options().length).toBe(3);
    expect(options().some((text) => text.includes("Claude Code transcripts"))).toBe(true);
    expect(engine.calls.filter(({ url }) => listing(url)).length).toBe(lists + 1);
    expect(read().mode).toBe("history"); // refreshing the list does not move the replay
  });
});

// 5. Archive-only projects ---------------------------------------------------------------------
describe("a project with archives but no live events", () => {
  it("opens the newest archive from the History entry and shows the picker", async () => {
    // Engine order and label order both differ from "newest": the Git archive ends latest.
    const engine = await mount({ archives: [TRANSCRIPTS, GIT], live: false });
    await historyButton().click();
    await expect.poll(() => read().mode).toBe("history");
    await expect.poll(() => read().state?.head).toBe(GIT_LOG.length);
    expect(read().state).toEqual(stateOf(GIT_LOG, GIT_LOG.length));
    expect(errorStatus().elements()).toHaveLength(0);
    await expect.element(picker()).toBeVisible();
    const names = picker()
      .getByRole("option")
      .elements()
      .map((option) => option.textContent ?? "");
    expect(names).toHaveLength(2);
    expect(names.join("|")).not.toContain("Live recording");
    expect(engine.calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("shows the picker for a single archive", async () => {
    await mount({ archives: [GIT], live: false });
    await historyButton().click();
    await expect.poll(() => read().state?.head).toBe(GIT_LOG.length);
    await expect.element(picker()).toBeVisible();
    expect(picker().getByRole("option").elements()).toHaveLength(1);
  });
});

// 6. Header layout -------------------------------------------------------------------------------
describe("a very long archive label", () => {
  const LONG = `Long label ${"x".repeat(189)}`;
  const LONGER = archive(GIT_ARCHIVE, "git", LONG, GIT_LOG);
  it("is ellipsized, titled in full, and the header stays inside a 900 px viewport", async () => {
    expect(LONG).toHaveLength(200);
    await page.viewport(900, 700);
    const engine = await mount({ archives: [LONGER] });
    await enterHistory(engine);
    await picker().selectOptions(page.getByRole("option", { name: /Long label/ }));
    await expect.poll(() => read().state?.head).toBe(GIT_LOG.length);
    const chip = page.getByText(/^HISTORY\s*·/).element() as HTMLElement;
    expect(chip.getAttribute("title") ?? "").toContain(LONG);
    const chipStyle = getComputedStyle(chip);
    expect(chipStyle.textOverflow).toBe("ellipsis");
    expect(chipStyle.overflow).toBe("hidden");
    expect(chip.scrollWidth).toBeGreaterThan(chip.clientWidth);
    const select = picker().element() as HTMLSelectElement;
    expect(select.getAttribute("title") ?? "").toContain(LONG);
    expect(getComputedStyle(select).textOverflow).toBe("ellipsis");
    const header = (historyButton().element() as HTMLElement).parentElement as HTMLElement;
    const box = header.getBoundingClientRect();
    expect(box.left).toBeGreaterThanOrEqual(0);
    expect(box.right).toBeLessThanOrEqual(window.innerWidth);
    await page.getByRole("button", { name: /^Back to live\b/i }).click();
    await expect.poll(() => read().mode).toBe("live");
  });
});

// 7. Read-only, through every request the stubs see -------------------------------------------
const PERMISSION = archive(
  "archive:7d1e9b22-0a3f-4f6c-8d15-c3e1a45f9203",
  "transcripts",
  "Permission transcript",
  archiveEvents("perm", [
    {
      type: "agent.registered",
      agentId: AGENT,
      sessionId: "archived-session",
      occurredAt: "2026-01-05T08:00:00Z",
      payload: {
        sourceAgentId: "archived-source",
        displayName: "Archived Ada",
        role: "reviewer",
        kind: "session",
      },
    },
    {
      type: "request.opened",
      agentId: AGENT,
      sessionId: "archived-session",
      occurredAt: "2026-01-05T08:01:00Z",
      payload: {
        requestId: "archived-request",
        kind: "permission",
        toolName: "Read",
        inputPreview: "Archived preview",
      },
    },
  ]),
);

describe("read-only archives", () => {
  it("sends no non-GET request and renders no Allow or Deny for an archived permission request", async () => {
    const cards = cardsEngine();
    const engine = layeredEngine({ base: cards.fetcher, archives: [PERMISSION] });
    vi.stubGlobal("fetch", engine.fetcher);
    selectProject(PROJECT);
    const view = await render(
      <SessionProvider value={SECRET}>
        <HistoryProvider>
          <Composition overlays />
        </HistoryProvider>
      </SessionProvider>,
    );
    cleanups.push(() => view.unmount());
    await expect.poll(() => dataStore.getState().connection).toBe("live");
    await userEvent.keyboard("h");
    await expect.poll(() => read().mode).toBe("history");
    await picker().selectOptions(page.getByRole("option", { name: /Permission transcript/ }));
    await expect.poll(() => read().state?.head).toBe(2);
    expect(read().state?.requests["archived-request"]).toMatchObject({ state: "open" });
    act(() => selectionStore.select(AGENT));
    const card = page.getByTestId("action-card");
    await expect.poll(() => card.elements().length).toBe(1);
    await expect.element(card).toHaveAttribute("data-readonly", "true");
    await expect.element(card).toMatchTextContent("Archived preview");
    expect(page.getByRole("button", { name: /^(allow|deny)/i }).elements()).toHaveLength(0);
    expect(card.element().querySelectorAll("button, textarea, input")).toHaveLength(0);
    await userEvent.keyboard("{Escape}");
    await expect.poll(() => read().mode).toBe("live");
    // Every request either stub saw, live and archive, while archives were involved.
    expect(engine.calls.filter(({ method }) => method !== "GET")).toEqual([]);
    expect(cards.calls.filter(({ method }) => method !== "GET")).toEqual([]);
  });
});

// 8. Archive to archive ----------------------------------------------------------------------------
describe("switching between archives mid-seek", () => {
  it("drops a delayed state response for the archive that was left", async () => {
    const engine = await mount({ archives: [GIT, TRANSCRIPTS] });
    await enterHistory(engine);
    await open(
      TRANSCRIPT_ARCHIVE,
      "Claude Code transcripts",
      TRANSCRIPT_LOG.length,
      TRANSCRIPT_LOG,
    );
    // Seek to the start of the transcripts; its state answer is held.
    const release = engine.hold(
      (url) => route(TRANSCRIPT_ARCHIVE, "state")(url) && url.searchParams.get("at") === "1",
    );
    const slider = page.getByRole("slider", { name: "Timeline time" });
    (slider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{Home}");
    await expect
      .poll(() =>
        engine.calls.some(
          ({ url }) =>
            url.searchParams.get("at") === "1" && route(TRANSCRIPT_ARCHIVE, "state")(url),
        ),
      )
      .toBe(true);
    // Leave for the Git archive while that answer is still in flight.
    forceChoose(GIT_ARCHIVE);
    await expect.poll(() => read().state?.head).toBe(GIT_LOG.length);
    const mark = seen.length;
    release();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(read().state).toEqual(stateOf(GIT_LOG, GIT_LOG.length));
    expect(seen.slice(mark).every((entry) => entry.agents.length === 0)).toBe(true);
    expect(Object.keys(read().state?.agents ?? {})).toEqual([]);
  });
});
