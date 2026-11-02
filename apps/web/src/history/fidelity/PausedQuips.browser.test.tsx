import { act } from "react";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { AGENT, cardsRecording } from "../../../test/history/ui/cards-fixture.ts";
import { stateAt } from "../../../test/history/ui/timeline-fixture.ts";
import { createDataStore } from "../../data/store.ts";
import { Bubbles } from "../../overlays/bubbles/Bubbles.tsx";
import { createAnchorSource } from "../../overlays/host/anchors.ts";
import { getSettingsStore } from "../../overlays/settings/index.ts";
import { quipSchedule } from "../../quips/schedule.ts";

const originalReduced = getSettingsStore().getSnapshot().reducedMotion;
const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  getSettingsStore().set("reducedMotion", originalReduced);
});

it("paused history quips retain recorded animation progress and follow recorded seeks/repeat windows", async () => {
  const log = cardsRecording();
  const sinceMs = Date.parse(log[2].occurredAt);
  let recordedNow = sinceMs + 1000;
  const store = createDataStore({ now: () => recordedNow });
  store.getState().applySnapshotState(stateAt(3, log));
  const anchors = createAnchorSource();
  anchors.setAnchor(`agent:${AGENT}`, [0, 0, 0]);
  anchors.setProjection([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1], {
    width: 900,
    height: 600,
  });
  getSettingsStore().set("reducedMotion", "off");
  const view = await render(
    <div style={{ position: "relative", width: 900, height: 600 }}>
      <Bubbles
        mode="history"
        store={store}
        anchors={anchors}
        selection={{ selectedId: AGENT, select() {} }}
        selectors={{
          counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 1, needsYou: 1 }) },
        }}
        intents={{ available: false, run() {} }}
        settings={{ get: (_key, fallback) => fallback, set() {} }}
      />
    </div>,
  );
  cleanups.push(() => view.unmount());
  const bubble = () => document.querySelector<HTMLElement>('[data-testid="quip-bubble"]');
  const opacity = () => Number(getComputedStyle(bubble() as HTMLElement).opacity);
  await expect.poll(() => bubble()?.textContent).toContain("Needs OK: Read");
  await expect.poll(opacity).toBeGreaterThan(0.95);
  const text = bubble()?.textContent;
  // Real CSS wall time passes while the presentation's recorded clock is paused.
  await new Promise((resolve) => setTimeout(resolve, 4200));
  expect(recordedNow).toBe(sinceMs + 1000);
  expect(bubble()?.textContent).toBe(text);
  expect(opacity()).toBeGreaterThan(0.95);
  act(() => {
    recordedNow = sinceMs + 3920;
    store.getState().refreshAttention();
  });
  await expect.poll(opacity).toBeLessThan(0.1);
  act(() => {
    recordedNow = sinceMs + 1000;
    store.getState().refreshAttention();
  });
  await expect.poll(opacity).toBeGreaterThan(0.95);
  act(() => {
    recordedNow = sinceMs + 4500;
    store.getState().refreshAttention();
  });
  await expect.poll(bubble).toBeNull();
  const second = quipSchedule({
    agentId: AGENT,
    eventId: "recorded-request",
    sinceMs,
    count: 2,
  })[1];
  expect(second).toBeDefined();
  act(() => {
    recordedNow = second.startMs + 1000;
    store.getState().refreshAttention();
  });
  await expect.poll(() => bubble()?.textContent).toBe(text);
  await expect.poll(opacity).toBeGreaterThan(0.95);
});
