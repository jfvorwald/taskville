import { act, useSyncExternalStore } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { needsYou, trouble } from "../../../test/audio/fakes.ts";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { type AttentionFrame, applyAttentionFrame } from "../../overlays/header/attention.ts";
import { attentionStore } from "../../overlays/header/attentionSync.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { HistoryControls } from "./HistoryControls.tsx";
import { HistoryProvider, useHistoryPresentation } from "./HistoryProvider.tsx";

// Real composition: no new component import/API, mocked history context, or layout rectangles.
function Presented() {
  const history = useHistoryPresentation();
  const view = useSyncExternalStore(history.store.subscribe, history.store.getState);
  return (
    <output aria-label="Pill presented state">
      {JSON.stringify({ mode: history.mode, state: view.state, needsYou: view.counts.needsYou })}
    </output>
  );
}
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.unstubAllGlobals();
  attentionStore.setState({ ready: false, feed: {} });
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
});

function frame(frame: AttentionFrame) {
  act(() => {
    const { feed } = attentionStore.getState();
    attentionStore.setState({
      feed: applyAttentionFrame(feed, frame),
      ...(frame.event === "snapshot" ? { ready: true } : {}),
    });
  });
}
const project = (projectId: string, ...agents: string[]) => ({
  projectId,
  name: projectId,
  attention: agents.map((agent) => needsYou(agent, `request-${agent}`)),
});
const snapshot = (...projects: ReturnType<typeof project>[]) =>
  frame({ event: "snapshot", data: { projects } });
const update = (data: ReturnType<typeof project>) => frame({ event: "attention", data });
const pill = () => page.getByRole("button", { name: /^Back to live\b/i });
const read = () =>
  JSON.parse(
    page.getByRole("status", { name: "Pill presented state" }).element().textContent ?? "null",
  );
async function recorded() {
  await expect.poll(read).toEqual({ mode: "history", state: stateAt(8), needsYou: 2 });
}
async function mount() {
  const transport = timelineEngine();
  vi.stubGlobal("fetch", transport.fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(stateAt(2));
  attentionStore.setState({ ready: false, feed: {} });
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <HistoryControls />
        <Presented />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  return { ...transport, view };
}
async function enter() {
  await page.getByRole("button", { name: "History", exact: true }).click();
  await recorded(); // Prove authenticated replay succeeded before the intended missing-pill red.
}

// Check the rendered affordance without requiring a particular CSS token, class or red shade.
function isRed() {
  const style = getComputedStyle(pill().element());
  return [style.color, style.backgroundColor, style.borderTopColor].some((color) => {
    const channels = color.match(/[\d.]+/g)?.map(Number) ?? [];
    const [r = 0, g = 0, b = 0, alpha = 1] = channels;
    return alpha > 0 && r > 80 && r > g * 1.3 && r > b * 1.3;
  });
}
async function count(n: number) {
  await expect
    .element(pill())
    .toHaveAccessibleName(new RegExp(`^Back to live.*\\b${n} needs you\\b`, "i"));
  await expect.element(pill()).toMatchTextContent(new RegExp(`\\b${n} needs you\\b`, "i"));
  expect(isRed()).toBe(n > 0);
}
async function clear() {
  await expect.element(pill()).toBeVisible();
  await expect.element(pill()).not.toHaveAccessibleName(/[1-9]\d* needs you/i);
  expect(isRed()).toBe(false);
}

describe("Back to live in the real history controls", () => {
  it("is absent live, fixed at viewport top center in history, and removed on exit/unmount", async () => {
    const { view } = await mount();
    snapshot(project("other", "a"));
    expect(pill().elements()).toHaveLength(0);
    await enter();
    await expect.element(pill()).toBeVisible(); // Intended RED: production composition has no pill.
    const element = pill().element();
    const box = element.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
    expect(Math.abs(box.left + box.width / 2 - window.innerWidth / 2)).toBeLessThanOrEqual(2);
    expect(box.top).toBeGreaterThanOrEqual(0);
    expect(box.bottom).toBeLessThan(window.innerHeight / 4);
    let positioned: Element | null = element;
    while (positioned && getComputedStyle(positioned).position !== "fixed")
      positioned = positioned.parentElement;
    expect(positioned, "pill or its positioning wrapper is fixed to the viewport").not.toBeNull();
    await page.getByRole("button", { name: "Return live", exact: true }).click();
    await expect.poll(() => read().mode).toBe("live");
    expect(pill().elements()).toHaveLength(0);
    await enter();
    await expect.element(pill()).toBeVisible();
    await view.unmount();
    update(project("other", "a", "b"));
    expect(pill().elements()).toHaveLength(0);
  });

  it("uses global live snapshots and updates while recorded needs-you stays at two", async () => {
    await mount();
    snapshot();
    await enter();
    await clear(); // Recorded requests must not make an empty global feed red.
    snapshot(project(PROJECT, "live-a"), project("other", "live-b", "live-c"));
    await count(3);
    await recorded();
    update(project("other", "live-b"));
    await count(2);
    // Multiple requests for one agent count once; trouble is not needs-you.
    frame({
      event: "attention",
      data: {
        ...project("other"),
        attention: [needsYou("live-b", "one"), needsYou("live-b", "two"), trouble("quiet")],
      },
    });
    await count(2);
    update(project(PROJECT));
    await count(1);
    update(project("other"));
    await clear();
    await recorded();
  });

  it("clears an untrusted reset and replaces stale projects on a reconnect snapshot", async () => {
    await mount();
    snapshot(project("other", "old-a", "old-b", "old-c"));
    await enter();
    await count(3);
    act(() => attentionStore.setState({ ready: false, feed: {} }));
    await clear();
    snapshot(project("replacement", "new-a"));
    await count(1);
    snapshot();
    await clear();
    await recorded();
  });

  it("returns immediately through the existing live action to the latest live snapshot", async () => {
    const transport = await mount();
    snapshot(project("other", "waiting"));
    await enter();
    await expect.element(pill()).toBeVisible();
    act(() => dataStore.getState().applySnapshotState(stateAt(6)));
    await recorded();
    const reads = transport.requests.length;
    await pill().click();
    // No replay catch-up, new fetch, command or alternative exit path.
    expect(read().mode).toBe("live");
    expect(read().state).toEqual(stateAt(6));
    expect(transport.requests).toHaveLength(reads);
    expect(pill().elements()).toHaveLength(0);
    expect(page.getByRole("button", { name: "Return live", exact: true }).elements()).toHaveLength(
      0,
    );
  });
});
