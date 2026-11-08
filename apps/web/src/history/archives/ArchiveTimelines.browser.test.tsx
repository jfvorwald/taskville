import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { stateAt } from "../../../test/history/ui/timeline-fixture.ts";
import { selectionStore } from "../../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "../ui/HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "../ui/HistoryProvider.tsx";
import {
  archiveEngine,
  GIT_ARCHIVE,
  GIT_LABEL,
  GIT_LOG,
  stateIn,
  TRANSCRIPT_ARCHIVE,
  TRANSCRIPT_LABEL,
  TRANSCRIPT_LOG,
} from "./archive-fixture.ts";

// Real composition only (provider, controls, overlays, session). Encoded contract for M8.03:
// - a native-or-ARIA combobox named "Timeline" inside history mode (rendered by HistoryControls)
//   whose options are "Live recording" first, then archives sorted by label; each archive option
//   names its kind ("Git" or "Transcripts") and its first and last date (occurredAt, local);
// - choosing an archive reads `/v1/timelines/archive:<uuid>/{events,state}` through the provider;
// - history chip and day labels use occurredAt; a "Git" chip shows for a Git archive;
// - markers for Git facts carry data-marker "Git commit" | "Git merge" | "Git ref moved".

function Composition() {
  const { store, mode } = useHistoryPresentation();
  const view = useSyncExternalStore(store.subscribe, store.getState);
  return (
    <>
      <output aria-label="Presented recording">
        {JSON.stringify({ mode, state: view.state })}
      </output>
      <HistoryControls />
    </>
  );
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  selectionStore.select(null);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

const read = () =>
  JSON.parse(
    page.getByRole("status", { name: "Presented recording" }).element().textContent ?? "null",
  );
const picker = () => page.getByRole("combobox", { name: "Timeline", exact: true });
const day = (iso: string) => new Date(iso).toLocaleDateString();

async function mount() {
  const engine = archiveEngine();
  vi.stubGlobal("fetch", engine.fetcher);
  selectProject(PROJECT);
  selectionStore.select(null);
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(stateAt(8));
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Composition />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  // Precondition: the live city has agents, so their absence in an archive is meaningful.
  expect(Object.keys(dataStore.getState().state?.agents ?? {})).toEqual(["a1", "a2"]);
  await page.getByRole("button", { name: "History", exact: true }).click();
  await expect.poll(() => read().mode).toBe("history");
  expect(read().state).toEqual(stateAt(8)); // live recording first; failure here is not the red.
  return engine;
}

async function choose(label: string) {
  await picker().selectOptions(page.getByRole("option", { name: new RegExp(label) }));
}
async function openGit() {
  const engine = await mount();
  await choose(GIT_LABEL);
  await expect.poll(() => read().state?.head).toBe(GIT_LOG.length);
  return engine;
}

describe("timeline picker", () => {
  it("is absent in live mode and an accessible, focusable control in history mode", async () => {
    const engine = archiveEngine();
    vi.stubGlobal("fetch", engine.fetcher);
    selectProject(PROJECT);
    dataStore.getState().reset(PROJECT);
    dataStore.getState().applySnapshotState(stateAt(8));
    const view = await render(
      <SessionProvider value={SECRET}>
        <HistoryProvider>
          <Composition />
        </HistoryProvider>
      </SessionProvider>,
    );
    cleanups.push(() => view.unmount());
    expect(picker().elements()).toHaveLength(0);
    await page.getByRole("button", { name: "History", exact: true }).click();
    await expect.element(picker()).toBeVisible();
    (picker().element() as HTMLElement).focus();
    await expect.element(picker()).toHaveFocus();
  });

  it("lists Live recording first, then archives by label with kind and date range", async () => {
    await mount();
    await expect.element(picker()).toBeVisible();
    const options = picker().getByRole("option").elements();
    const names = options.map((option) => option.textContent ?? "");
    expect(names).toHaveLength(3);
    expect(names[0]).toMatch(/^Live recording/);
    // Sorted by label, not engine order (the Git archive is first from the engine).
    expect(names[1]).toContain(TRANSCRIPT_LABEL);
    expect(names[2]).toContain(GIT_LABEL);
    expect(names[1]).toMatch(/transcripts/i);
    expect(names[2]).toMatch(/\bgit\b/i);
    expect(names[2]).toContain(day(GIT_LOG[0].occurredAt));
    expect(names[2]).toContain(day(GIT_LOG.at(-1)?.occurredAt ?? ""));
    expect(names[1]).toContain(day(TRANSCRIPT_LOG[0].occurredAt));
  });
});

describe("opening an archive", () => {
  it("reads state and events through the archive timeline id, never the live one", async () => {
    const engine = await mount();
    expect(engine.requests).toHaveLength(0);
    await choose(GIT_LABEL);
    await expect.poll(() => read().state).toEqual(stateIn(GIT_LOG, GIT_LOG.length));
    expect(read().mode).toBe("history");
    const paths = engine.requests.map((url) => decodeURIComponent(url.pathname));
    expect(paths).toContain(`/v1/timelines/${GIT_ARCHIVE}/events`);
    expect(paths).toContain(`/v1/timelines/${GIT_ARCHIVE}/state`);
  });

  it("scrubs by archive position and shows the occurredAt range in the chip and strip", async () => {
    await openGit();
    const first = GIT_LOG[0].occurredAt;
    const last = GIT_LOG.at(-1)?.occurredAt ?? "";
    const chip = page.getByText(/^HISTORY\s*·/);
    await expect.element(chip).toHaveTextContent(new Date(last).toLocaleString());
    await expect.element(chip).toHaveTextContent(GIT_LABEL);
    // Day labels are occurred days; the import day (receivedAt) must not appear.
    for (const iso of [first, "2026-03-03T10:00:00Z", last])
      await expect.element(page.getByText(day(iso), { exact: true })).toBeVisible();
    expect(page.getByText(day("2026-11-08T09:00:00Z"), { exact: true }).elements()).toHaveLength(0);
    const slider = page.getByRole("slider", { name: "Timeline time" });
    (slider.element() as HTMLInputElement).focus();
    await userEvent.keyboard("{Home}");
    await expect.poll(() => read().state).toEqual(stateIn(GIT_LOG, 1));
    await expect.element(chip).toHaveTextContent(new Date(first).toLocaleString());
  });
});

describe("Git-only facts", () => {
  it("gives commits, merges and ref moves their own tick styles and a Git chip", async () => {
    await openGit();
    await expect.element(page.getByText("Git", { exact: true })).toBeVisible();
    expect(page.getByText("Git", { exact: true }).elements()).toHaveLength(1);
    const kinds = ["Git commit", "Git ref moved", "Git merge"] as const;
    for (const kind of kinds) {
      const ticks = page.getByRole("button", { name: new RegExp(kind, "i") });
      expect(ticks.elements().length).toBe(kind === "Git commit" ? 2 : 1);
      for (const tick of ticks.elements()) expect(tick.getAttribute("data-marker")).toBe(kind);
    }
    // Not the live "Commit" marker style.
    expect(document.querySelectorAll('[data-marker="Commit"]')).toHaveLength(0);
  });

  it("shows no agent cards and no write actions, and sends nothing but reads", async () => {
    const engine = await openGit();
    // The presented store (what the overlays render) holds no agents: no cards to show.
    expect(Object.keys(read().state.agents)).toEqual([]);
    expect(document.querySelectorAll("[data-agent-id]")).toHaveLength(0);
    for (const name of [/approve/i, /deny/i, /allow/i, /send/i, /assign/i, /stop/i, /pause agent/i])
      expect(page.getByRole("button", { name }).elements()).toHaveLength(0);
    expect(engine.requests.every((url) => url.pathname.startsWith("/v1/timelines/"))).toBe(true);
  });

  it("does not show the Git chip for a transcript archive", async () => {
    await mount();
    await choose(TRANSCRIPT_LABEL);
    await expect.poll(() => read().state).toEqual(stateIn(TRANSCRIPT_LOG, TRANSCRIPT_LOG.length));
    const paths = page.getByText("Git", { exact: true }).elements();
    expect(paths).toHaveLength(0);
    expect(TRANSCRIPT_ARCHIVE).toMatch(/^archive:/);
  });
});

describe("returning to live from an archive", () => {
  const live = async () => {
    await expect.poll(() => read().mode).toBe("live");
    expect(read().state).toEqual(stateAt(8));
    expect(picker().elements()).toHaveLength(0);
  };

  it("Back to live pill returns to the live city", async () => {
    await openGit();
    await page.getByRole("button", { name: /^Back to live\b/i }).click();
    await live();
  });

  it("L returns to live", async () => {
    await openGit();
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("l");
    await live();
  });

  it("Escape returns to live", async () => {
    await openGit();
    (document.activeElement as HTMLElement | null)?.blur();
    await userEvent.keyboard("{Escape}");
    await live();
  });

  it("choosing Live recording from the picker returns to the live recording, still in history", async () => {
    await openGit();
    await choose("Live recording");
    await expect.poll(() => read().state).toEqual(stateAt(8));
    expect(read().mode).toBe("history");
  });
});
