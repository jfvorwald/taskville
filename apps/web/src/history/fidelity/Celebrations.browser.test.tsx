import { act } from "react";
import type { InstancedMesh, Scene } from "three";
import { afterEach, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { storedEnvelopeSchema } from "../../../../../packages/protocol/src/index.ts";
import { PROJECT, SECRET } from "../../../test/data/fake-engine.ts";
import { LOG, stateAt, timelineEngine } from "../../../test/history/ui/timeline-fixture.ts";
import { lightingController } from "../../city/lighting/instance.ts";
import { DEFAULT_PROJECT_ID, selectProject } from "../../data/project.ts";
import { dataStore } from "../../data/store.ts";
import { worldAnchors } from "../../overlays/host/index.ts";
import { getSettingsStore } from "../../overlays/settings/index.ts";
import { SessionProvider } from "../../pairing/session.tsx";
import { themeController } from "../../themes/core/index.ts";
import { HistoryProvider } from "../ui/HistoryProvider.tsx";
import { CityComposition, position } from "./fixtures/composition.tsx";

const START = Date.parse("2026-10-30T12:00:00Z");
// A merge needs no agent anchor. A later event leaves room to observe the crossing before EOF.
const log = [
  LOG[0],
  {
    ...LOG[5],
    type: "git.merge",
    payload: {
      repo: "synthetic-fidelity",
      sha: "a".repeat(40),
      parents: ["b".repeat(40), "c".repeat(40)],
    },
  },
  LOG[1],
].map((event, i) =>
  storedEnvelopeSchema.parse({
    ...event,
    ingestSequence: i + 1,
    occurredAt: new Date(START + [0, 500, 60_000][i]).toISOString(),
    receivedAt: new Date(START + [0, 500, 60_000][i]).toISOString(),
  }),
);
const cleanups: Array<() => Promise<void>> = [];
const originalTheme = themeController.store.getState();
const originalSetting = getSettingsStore().getSnapshot().reducedMotion;
const originalLighting = lightingController.getTime();
afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) await cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
  dataStore.getState().reset(DEFAULT_PROJECT_ID);
  selectProject(DEFAULT_PROJECT_ID);
  getSettingsStore().set("reducedMotion", originalSetting);
  lightingController.setTime(originalLighting);
  themeController.setTheme(originalTheme.themeId);
  themeController.setHistory(originalTheme.history);
  themeController.setMode(originalTheme.mode);
  worldAnchors.replaceAnchors("agent:", {});
});

function click(name: string) {
  act(() =>
    (page.getByRole("button", { name, exact: true }).element() as HTMLButtonElement).click(),
  );
}
async function mount() {
  const transport = timelineEngine(log);
  vi.stubGlobal("fetch", transport.fetcher);
  selectProject(PROJECT);
  dataStore.getState().reset(PROJECT);
  dataStore.getState().applySnapshotState(stateAt(1, log));
  getSettingsStore().set("reducedMotion", "off");
  let scene: Scene | undefined;
  const view = await render(
    <SessionProvider value={SECRET}>
      <HistoryProvider>
        <CityComposition
          onScene={(s) => {
            scene = s;
          }}
        />
      </HistoryProvider>
    </SessionProvider>,
  );
  cleanups.push(() => view.unmount());
  // Read the actual rig mesh, not a replacement component or trigger helper. The only 60-slot
  // instanced burst in the city is Celebrations' Archives merge burst (40/14/60 rig capacities).
  const merges = () => {
    const found: InstancedMesh[] = [];
    scene?.traverse((object) => {
      if (
        (object as InstancedMesh).isInstancedMesh === true &&
        (object as InstancedMesh).count === 60
      )
        found.push(object as InstancedMesh);
    });
    return found;
  };
  await expect.poll(() => merges().length).toBe(1);
  expect(merges()[0].visible).toBe(false);
  return { visible: () => merges()[0]?.visible, transport };
}

it("a real live merge starts the mounted City's drawn effect (positive renderer/event control)", async () => {
  const { visible } = await mount();
  act(() => dataStore.getState().applyEvent(log[1]));
  expect(dataStore.getState().state?.head).toBe(2);
  await expect.poll(() => visible()).toBe(true);
});

it("a live merge cannot start a drawn celebration while the City presents history", async () => {
  const { visible } = await mount();
  click("History");
  await position(3);
  // History's snapshot load itself did not draw a burst.
  expect(visible()).toBe(false);
  act(() => dataStore.getState().applyEvent(log[1]));
  expect(dataStore.getState().state?.head).toBe(2);
  await position(3);
  // Wait for the real frame that makes emitted particles visible, without sleeping a burst away.
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  expect(visible(), "LIVE merge leaked into the recorded city").toBe(false);
});

it.each([1, 10])(
  "crossing a recorded merge at %ix starts the mounted replay effect",
  async (rate) => {
    const { visible, transport } = await mount();
    click("History");
    await position(3);
    click("Previous moment");
    await position(2);
    click("Previous moment");
    await position(1);
    expect(visible()).toBe(false);
    act(() => {
      const select = page
        .getByRole("combobox", { name: "Playback speed" })
        .element() as HTMLSelectElement;
      const option = [...select.options].find((item) => item.textContent === `${rate}x`);
      expect(option).toBeDefined();
      select.value = option?.value ?? "";
      select.dispatchEvent(new Event("change", { bubbles: true }));
    });
    click("Play");
    await position(2, rate);
    expect(transport.requests.some((url) => url.searchParams.get("at") === "2")).toBe(true);
    expect(dataStore.getState().state?.head).toBe(1);
    await expect.poll(() => visible()).toBe(true);
  },
);
