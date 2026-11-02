import { act, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { storedEnvelopeSchema } from "../../../../../packages/protocol/src/index.ts";
import { FakeEngine, frame, PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { stateAt, TIMELINE, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { selectionStore } from "../../city/interaction/selection.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { OverlayRoot } from "../../overlays/index.tsx";
import { SESSION_HEADER } from "../../pairing/pair.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "./HistoryProvider.tsx";

const ADA = "selected-ada";
const BEA = "other-bea";
const TASK = "adas-current-task";
const START = 5;
const HEAD = 12;
const ENTRY = "How did we get here?";

// One observed task lifecycle, no reopen/handoff/heuristic attribution. Creation is the
// first record naming TASK. Later same-task activities cannot replace that beginning.
const specs = [
  {
    type: "agent.registered",
    agentId: ADA,
    payload: {
      sourceAgentId: ADA,
      displayName: "Selected Ada",
      role: "developer",
      kind: "session",
    },
  },
  { type: "agent.connected", agentId: ADA, payload: {} },
  {
    type: "agent.registered",
    agentId: BEA,
    payload: { sourceAgentId: BEA, displayName: "Other Bea", role: "reviewer", kind: "session" },
  },
  { type: "agent.connected", agentId: BEA, payload: {} },
  { type: "task.created", agentId: ADA, taskId: TASK, payload: { title: "Ada's current task" } },
  // Same received millisecond as START, but a different task/agent and state hash.
  { type: "task.created", agentId: BEA, taskId: "other-task", payload: { title: "Bea's task" } },
  { type: "task.assigned", agentId: ADA, taskId: TASK, payload: { agentIds: [ADA] } },
  { type: "task.status_changed", agentId: ADA, taskId: TASK, payload: { status: "running" } },
  { type: "activity.started", agentId: ADA, taskId: TASK, payload: { activity: "researching" } },
  { type: "activity.started", agentId: ADA, taskId: TASK, payload: { activity: "testing" } },
  // Bea is known, connected and active, but has no recorded current task attribution.
  { type: "activity.started", agentId: BEA, payload: { activity: "researching" } },
  { type: "activity.started", agentId: ADA, taskId: TASK, payload: { activity: "documenting" } },
];
const log = specs.map((spec, index) => {
  const at = new Date(
    Date.parse("2026-11-01T12:00:00Z") + (index === 5 ? 4 : index) * 1000,
  ).toISOString();
  return storedEnvelopeSchema.parse({
    ...spec,
    schemaVersion: 1,
    projectId: PROJECT,
    sourceId: "synthetic-task-history",
    sourceEventId: `task-history-${index + 1}`,
    eventId: `00000000-0000-4000-8005-${String(index + 1).padStart(12, "0")}`,
    ingestSequence: index + 1,
    receivedAt: at,
    occurredAt: at,
    evidenceIds: [],
    provenance: "live",
    late: false,
  });
});

// Only the SceneRoot composition seam is reproduced. OverlayRoot mounts the real
// PresentedSidebar/AgentPanel and owns live sync. No panel/controller/context mocks.
function Composition() {
  const history = useHistoryPresentation();
  const view = useSyncExternalStore(history.store.subscribe, history.store.getState);
  return (
    <>
      <output aria-label="Task history position">
        {history.mode}:{view.state?.head ?? 0}
      </output>
      <output aria-label="Task history state">{JSON.stringify(view.state)}</output>
      <OverlayRoot store={history.store} mode={history.mode} />
      <HistoryControls />
    </>
  );
}

function engine() {
  const live = new FakeEngine(log);
  const timeline = timelineEngine(log);
  const calls: Array<{ url: URL; method: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    expect(method).toBe("GET");
    expect(new Headers(init?.headers).get(SESSION_HEADER)).toBe(SECRET);
    if (url.pathname.includes("/timelines")) return timeline.fetcher(input, init);
    if (url.pathname === "/v1/attention/events" || /\/agents\/[^/]+\/feed$/.test(url.pathname)) {
      if (url.pathname.includes("/agents/")) {
        expect(url.searchParams.get("projectId")).toBe(PROJECT);
        expect([ADA, BEA]).toContain(decodeURIComponent(url.pathname.split("/")[3] ?? ""));
      }
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          if (url.pathname === "/v1/attention/events")
            controller.enqueue(
              new TextEncoder().encode(
                frame("snapshot", {
                  projects: [],
                  computedAt: log[HEAD - 1].receivedAt,
                }),
              ),
            );
          init?.signal?.addEventListener("abort", () => controller.close(), { once: true });
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    expect([`/v1/projects/${PROJECT}/snapshot`, `/v1/projects/${PROJECT}/events`]).toContain(
      url.pathname,
    );
    return live.fetch(input, init);
  };
  return { calls, fetcher, timeline };
}

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  selectionStore.select(null);
  selectProject(DEFAULT_PROJECT_ID);
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
});
async function position(sequence: number, mode = "history") {
  await expect
    .element(page.getByRole("status", { name: "Task history position" }))
    .toHaveTextContent(`${mode}:${sequence}`);
}
async function mount(agentId = ADA) {
  const transport = engine();
  vi.stubGlobal("fetch", transport.fetcher);
  selectProject(PROJECT);
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <Composition />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  await position(HEAD, "live");
  await expect.poll(() => dataStore.getState().connection).toBe("live");
  expect(dataStore.getState().state).toEqual(stateAt(HEAD, log));
  act(() => selectionStore.select(agentId));
  await expect.element(page.getByTestId("agent-panel")).toHaveAttribute("data-agent-id", agentId);
  await expect
    .element(page.getByTestId("agent-panel-name"))
    .toHaveTextContent(agentId === ADA ? "Selected Ada" : "Other Bea");
  return transport;
}

const panelEntry = () =>
  page.getByTestId("agent-panel").getByRole("button", { name: ENTRY, exact: true });

describe("selected agent task history through production sidebar", () => {
  it("proves replay fixture positions and the existing provider route before testing the new entry", async () => {
    expect(log.filter((event) => event.taskId === TASK)[0]).toMatchObject({
      type: "task.created",
      ingestSequence: START,
      agentId: ADA,
      late: false,
    });
    expect(stateAt(HEAD, log).activity[ADA]).toMatchObject({
      taskId: TASK,
      activity: "documenting",
      heuristic: false,
      since: log[HEAD - 1].occurredAt,
    });
    expect(stateAt(START - 1, log).tasks[TASK]).toBeUndefined();
    expect(stateAt(START, log).tasks[TASK]).toMatchObject({
      title: "Ada's current task",
      status: "queued",
    });
    expect(stateAt(START, log).tasks["other-task"]).toBeUndefined();
    const transport = await mount();
    const read = async (at: string) =>
      (
        await transport.fetcher(
          `/v1/timelines/${encodeURIComponent(TIMELINE)}/state?at=${encodeURIComponent(at)}`,
          { headers: { [SESSION_HEADER]: SECRET } },
        )
      ).json();
    const start = await read(String(START));
    const neighbor = await read(log[START - 1].receivedAt);
    expect(start.at).toBe(START);
    expect(start.state).toEqual(stateAt(START, log));
    expect(neighbor.at).toBe(START + 1);
    expect(neighbor.state).toEqual(stateAt(START + 1, log));
    expect(start.stateHash).not.toBe(neighbor.stateHash);
    // Canvas-free overlay composition overlaps the header; use the real H shortcut,
    // as HistoryCards does, without forcing a click through camera controls.
    await userEvent.keyboard("h");
    await position(HEAD);
    expect(transport.timeline.requests.some((url) => url.pathname.endsWith("/events"))).toBe(true);
    // Exercise real sequence navigation and presentation with the same fixture independently
    // of the missing entry. No direct call to a history controller method is needed.
    for (let sequence = HEAD - 1; sequence >= START; sequence--) {
      await page.getByRole("button", { name: "Previous moment" }).click();
      await position(sequence);
    }
    expect(
      JSON.parse(
        page.getByRole("status", { name: "Task history state" }).element().textContent ?? "null",
      ),
    ).toEqual(start.state);
  });

  it("opens at the selected agent's recorded task beginning, not head, latest activity or a same-time neighbor", async () => {
    const transport = await mount();
    await expect.element(page.getByTestId("agent-panel-status")).toHaveTextContent("Documenting");
    expect(dataStore.getState().state?.activity[ADA]).toMatchObject({
      taskId: TASK,
      heuristic: false,
    });
    // RED: all live prerequisites above must pass before this missing accessible entry.
    await expect.element(panelEntry()).toBeVisible();
    await panelEntry().click();
    await position(START);
    expect(selectionStore.getSnapshot()).toBe(ADA);
    expect(
      JSON.parse(
        page.getByRole("status", { name: "Task history state" }).element().textContent ?? "null",
      ),
    ).toEqual(stateAt(START, log));
    await expect.element(page.getByTestId("agent-panel")).toHaveAttribute("data-readonly", "true");
    expect(dataStore.getState().state).toEqual(stateAt(HEAD, log));
    expect(
      transport.timeline.requests
        .filter((url) => url.pathname.endsWith("/state"))
        .at(-1)
        ?.searchParams.get("at"),
    ).toBe(String(START));
    expect(transport.calls.every(({ method }) => method === "GET")).toBe(true);
  });

  it("does not guess a history jump for an active selected agent with no recorded current task", async () => {
    const transport = await mount(BEA);
    expect(dataStore.getState().state?.activity[BEA]).toMatchObject({
      activity: "researching",
      heuristic: false,
    });
    expect(dataStore.getState().state?.activity[BEA]?.taskId).toBeUndefined();
    const entries = panelEntry().elements();
    // An unavailable entry may be omitted or disabled; no invented fallback task/head jump.
    if (entries.length) await expect.element(panelEntry()).toBeDisabled();
    await position(HEAD, "live");
    expect(transport.timeline.requests).toEqual([]);
  });
});
