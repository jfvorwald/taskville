import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { SettingsPanel } from "../SettingsPanel.tsx";
import { createSettingsStore } from "../store.ts";
import { BreakTimeSection } from "./BreakTimeSection.tsx";

// M9.04: the "Break time" switch.
//
// Intended interface (apps/web/src/overlays/settings/breaks/BreakTimeSection.tsx):
//   <BreakTimeSection store?: SettingsStore />   // defaults to getSettingsStore()
// A switch (role "switch") named "Break time" bound to `breakTime` in the settings store, ON by
// default, with a line of help text. SettingsPanel mounts it in its open body.
// Run: pnpm --filter @taskville/web test:browser src/overlays/settings/breaks

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const NAME = "Break time";

describe("BreakTimeSection", () => {
  it("is on by default", async () => {
    await render(<BreakTimeSection store={createSettingsStore(memoryStorage())} />);
    await expect.element(page.getByRole("switch", { name: NAME })).toBeChecked();
  });

  it("turns off and on, writing the setting to the store", async () => {
    const store = createSettingsStore(memoryStorage());
    await render(<BreakTimeSection store={store} />);
    await page.getByRole("switch", { name: NAME }).click();
    await expect.element(page.getByRole("switch", { name: NAME })).not.toBeChecked();
    expect(store.getSnapshot().breakTime).toBe(false);
    await page.getByRole("switch", { name: NAME }).click();
    await expect.element(page.getByRole("switch", { name: NAME })).toBeChecked();
    expect(store.getSnapshot().breakTime).toBe(true);
  });

  it("stays off across a reload (a fresh store and section over the same storage)", async () => {
    const storage = memoryStorage();
    const first = await render(<BreakTimeSection store={createSettingsStore(storage)} />);
    await page.getByRole("switch", { name: NAME }).click();
    await first.unmount();
    await render(<BreakTimeSection store={createSettingsStore(storage)} />);
    await expect.element(page.getByRole("switch", { name: NAME })).not.toBeChecked();
  });

  it("follows a change made elsewhere in the same store", async () => {
    const store = createSettingsStore(memoryStorage());
    await render(<BreakTimeSection store={store} />);
    store.set("breakTime", false);
    await expect.element(page.getByRole("switch", { name: NAME })).not.toBeChecked();
  });
});

describe("SettingsPanel", () => {
  const overlayProps: OverlayProps = {
    mode: "live",
    selectors: {
      counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
    },
    selection: { selectedId: null, select: () => {} },
    anchors: createAnchorSource(),
    intents: { available: true, run: () => {} },
    settings: { get: (_k, f) => f, set: () => {} },
  };

  it("shows the Break time switch in its open body, on by default", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect.element(page.getByRole("switch", { name: NAME })).toBeVisible();
    await expect.element(page.getByRole("switch", { name: NAME })).toBeChecked();
  });
});
