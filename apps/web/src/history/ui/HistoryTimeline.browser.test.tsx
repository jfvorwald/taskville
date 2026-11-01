import { useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { storedEnvelopeSchema } from "../../../../../packages/protocol/src/index.ts";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import {
  LOG,
  retiredAgentRecording,
  stateAt,
  TIMELINE,
  timelineEngine,
} from "../../../test/history/ui/timeline-fixture.ts";
import { attention, projectStateHash, snapshotResponseSchema } from "../../data/domain.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "./HistoryProvider.tsx";

function Presented() {
  const history = useHistoryPresentation();
  const view = useSyncExternalStore(history.store.subscribe, history.store.getState);
  return (
    <output aria-label="Timeline presented state">
      {JSON.stringify({ mode: history.mode, state: view.state })}
    </output>
  );
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});
async function presented(sequence: number, log = LOG) {
  await expect
    .poll(() =>
      JSON.parse(
        page.getByRole("status", { name: "Timeline presented state" }).element().textContent ??
          "null",
      ),
    )
    .toEqual({ mode: "history", state: stateAt(sequence, log) });
}
async function mount(log = LOG) {
  const transport = timelineEngine(log);
  vi.stubGlobal("fetch", transport.fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(stateAt(log.length, log));
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <HistoryControls />
        <Presented />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await page.getByRole("button", { name: "History", exact: true }).click();
  await presented(log.length, log); // UI red must follow successful real replay, never transport failure.
  return transport;
}
const escapePattern = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// Semantic categories and recorded local time, without prescribing SVG, colors or binning.
const kinds = /needs.?you|permission|complet|commit/i;
const markers = () => page.getByRole("button", { name: kinds });
function marker(sequence: number, kind: string, agent?: string) {
  const time = new Date(LOG[sequence - 1].receivedAt).toLocaleString();
  return page.getByRole("button", {
    name: new RegExp(
      `(?=.*(?:${kind}))(?=.*${escapePattern(time)})${agent ? `(?=.*${escapePattern(agent)})` : ""}`,
      "i",
    ),
  });
}
async function density(count: number) {
  const graphic = page.getByRole("img", { name: /event density/i });
  await expect.element(graphic).toBeVisible();
  await expect
    .element(graphic)
    .toHaveAccessibleName(new RegExp(`\\b${count} recorded events\\b`, "i"));
  expect(graphic.elements()).toHaveLength(1);
}
async function chooseAgent(name: string) {
  await page
    .getByRole("combobox", { name: /agent/i })
    .selectOptions(page.getByRole("option", { name, exact: true }));
}
async function endpoint(key: "Home" | "End") {
  (page.getByRole("slider", { name: "Timeline time" }).element() as HTMLInputElement).focus();
  await userEvent.keyboard(`{${key}}`);
}

it("fixture control validates real wire responses and distinct whole-project reduced states", async () => {
  const engine = timelineEngine();
  const read = async (path: string) =>
    (await engine.fetcher(path, { headers: { [SESSION_HEADER]: SECRET } })).json();
  const metadata = await read(`/v1/projects/${PROJECT}/timelines`);
  expect(metadata.timelines[0].eventCount).toBe(8);
  const events = await read(`/v1/timelines/${encodeURIComponent(TIMELINE)}/events`);
  expect(events.events).toEqual(LOG);
  expect(events.nextCursor).toBeNull();
  const states = [];
  for (const at of [4, 5, 6, 7, 8]) {
    const {
      timelineId,
      at: received,
      ...wire
    } = await read(`/v1/timelines/${encodeURIComponent(TIMELINE)}/state?at=${at}`);
    const parsed = snapshotResponseSchema.parse({ projectId: PROJECT, ...wire });
    expect(timelineId).toBe(TIMELINE);
    expect(received).toBe(at);
    expect(parsed.state).toEqual(stateAt(at));
    expect(parsed.stateHash).toBe(projectStateHash(stateAt(at)));
    states.push(parsed.stateHash);
  }
  expect(new Set(states).size).toBe(5);
  expect(stateAt(4).requests.r1.state).toBe("open");
  expect(attention(stateAt(4), Date.parse(LOG[3].receivedAt))).toEqual(
    expect.arrayContaining([expect.objectContaining({ agentId: "a1", level: "needs_you" })]),
  );
  expect(stateAt(5).tasks.t1.status).toBe("completed");
  expect(stateAt(5).tasks.t1.assignedAgentIds).toEqual([]); // recorded actor is not an assignment
  expect(Object.keys(stateAt(5).agents)).toEqual(["a1", "a2"]);
});

describe("recorded timeline strip through real provider and controls", () => {
  it("shows local received-date markers and an honest loaded event-density graphic", async () => {
    await mount();
    await density(8); // Intended RED: missing accessible graphic.
    const days = [...new Set(LOG.map((event) => new Date(event.receivedAt).toLocaleDateString()))];
    expect(days).toHaveLength(2);
    for (const day of days) {
      const label = page.getByText(day, { exact: true });
      await expect.element(label).toBeVisible();
      expect(label.elements()).toHaveLength(1);
    }
  });

  it("distinguishes recorded needs-you, completion and commit markers and seeks exact state", async () => {
    await mount();
    expect(markers().elements()).toHaveLength(5); // Intended RED: no marker buttons.
    for (const [sequence, kind, agent] of [
      [4, "needs.?you|permission", "Ada"],
      [5, "complet", "Bea"],
      [6, "commit", "Ada"],
      [7, "needs.?you|permission", "Bea"],
      [8, "commit", undefined],
    ] as const) {
      const tick = marker(sequence, kind, agent);
      expect(tick.elements()).toHaveLength(1);
      await tick.click();
      await presented(sequence);
    }
    await expect.element(marker(8, "commit")).not.toHaveAccessibleName(/Ada|Bea/);
  });

  it("filters markers and moment navigation by recorded agent while replaying the whole city", async () => {
    const transport = await mount();
    const filter = page.getByRole("combobox", { name: /agent/i });
    await expect.element(filter).toBeVisible(); // Intended RED: missing filter.
    expect((filter.element() as HTMLSelectElement).selectedOptions[0]?.textContent).toBe(
      "All agents",
    );
    await expect.element(filter).toMatchTextContent("All agents");
    await expect.element(filter).toMatchTextContent("Ada");
    await expect.element(filter).toMatchTextContent("Bea");
    for (const [name, sequences, count] of [
      ["Ada", [1, 4, 6], 3],
      ["Bea", [2, 3, 5, 7], 4],
    ] as const) {
      await chooseAgent(name);
      await density(count);
      expect(markers().elements()).toHaveLength(2);
      const other = name === "Ada" ? "Bea" : "Ada";
      expect(
        page
          .getByRole("button", { name: new RegExp(`(?=.*(?:${kinds.source}))(?=.*${other})`, "i") })
          .elements(),
      ).toHaveLength(0);
      expect(marker(8, "commit").elements()).toHaveLength(0);
      // Full recording remains reachable even while the moment buttons follow the filter.
      await endpoint("Home");
      await presented(1);
      for (const sequence of sequences.filter((value) => value > 1)) {
        await page.getByRole("button", { name: "Next moment" }).click();
        await presented(sequence);
      }
      await expect.element(page.getByRole("button", { name: "Next moment" })).toBeDisabled();
      for (const sequence of [...sequences].reverse().slice(1)) {
        await page.getByRole("button", { name: "Previous moment" }).click();
        await presented(sequence);
      }
      await expect.element(page.getByRole("button", { name: "Previous moment" })).toBeDisabled();
      await endpoint("End");
      await presented(8);
      await page.getByRole("button", { name: "Previous moment" }).click();
      await presented(sequences.at(-1) ?? 0);
    }
    await chooseAgent("All agents");
    await density(8);
    expect(markers().elements()).toHaveLength(5);
    await marker(8, "commit").click();
    await presented(8);
    await page.getByRole("button", { name: "Previous moment" }).click();
    await presented(7);
    expect(transport.requests.every((url) => !url.searchParams.has("agentId"))).toBe(true);
  });
});

describe("heuristic needs-you markers are labeled as guesses", () => {
  // Event 4 is a request the source attributed by guess; event 7 stays an observed request.
  const guessed = LOG.map((event) =>
    event.ingestSequence === 4
      ? storedEnvelopeSchema.parse({ ...event, payload: { ...event.payload, heuristic: true } })
      : event,
  );
  const labelAt = (sequence: number) =>
    `${new Date(LOG[sequence - 1].receivedAt).toLocaleString()}`;
  const byLabel = (start: RegExp, sequence: number) =>
    page.getByRole("button", {
      name: new RegExp(`${start.source}.*${escapePattern(labelAt(sequence))}`, "i"),
    });

  it("labels a heuristic request.opened marker 'Possibly needs you', never plain 'Needs you'", async () => {
    await mount(guessed);
    const guess = byLabel(/^Possibly needs you/, 4);
    expect(guess.elements()).toHaveLength(1);
    await expect.element(guess).toHaveAccessibleName(/Ada/);
    expect(byLabel(/^Needs you/, 4).elements()).toHaveLength(0);
    // A guessed marker is still a recorded moment: it seeks like any other.
    await page.getByRole("button", { name: "Previous moment" }).click();
    await presented(7, guessed);
    await guess.click();
    await presented(4, guessed);
  });

  it("keeps the plain 'Needs you' label for an observed request beside a guessed one", async () => {
    await mount(guessed);
    const observed = byLabel(/^Needs you/, 7);
    expect(observed.elements()).toHaveLength(1);
    await expect.element(observed).toHaveAccessibleName(/Bea/);
    expect(byLabel(/^Possibly needs you/, 7).elements()).toHaveLength(0);
    // Exactly one guessed and one observed needs-you marker in this recording.
    expect(page.getByRole("button", { name: /^Possibly needs you/i }).elements()).toHaveLength(1);
    expect(page.getByRole("button", { name: /^Needs you/i }).elements()).toHaveLength(1);
  });
});

it("retains a finished agent pruned from head for recorded markers and navigation", async () => {
  const log = retiredAgentRecording();
  const head = stateAt(log.length, log);
  expect(head.retired.agents).toBe(1);
  expect(Object.hasOwn(head.agents, "retired")).toBe(false);
  expect(stateAt(5, log).agents.retired.finishedAt).toBe(log[4].occurredAt);
  await mount(log);
  expect(
    page.getByRole("option", { name: "Retired reviewer", exact: true }).elements(),
  ).toHaveLength(1);
  await chooseAgent("Retired reviewer");
  await density(5);
  expect(markers().elements()).toHaveLength(2);
  const complete = page.getByRole("button", { name: /Task completed.*Retired reviewer/i });
  const commit = page.getByRole("button", { name: /Commit.*Retired reviewer/i });
  await complete.click();
  await presented(3, log);
  await commit.click();
  await presented(4, log);
  await endpoint("End");
  await presented(log.length, log);
  for (const sequence of [5, 4, 3, 2, 1]) {
    await page.getByRole("button", { name: "Previous moment" }).click();
    await presented(sequence, log);
  }
  await expect.element(page.getByRole("button", { name: "Previous moment" })).toBeDisabled();
  for (const sequence of [2, 3, 4, 5]) {
    await page.getByRole("button", { name: "Next moment" }).click();
    await presented(sequence, log);
  }
  await expect.element(page.getByRole("button", { name: "Next moment" })).toBeDisabled();
  expect(
    (page.getByRole("combobox", { name: /agent/i }).element() as HTMLSelectElement)
      .selectedOptions[0]?.textContent,
  ).toBe("Retired reviewer");
});
