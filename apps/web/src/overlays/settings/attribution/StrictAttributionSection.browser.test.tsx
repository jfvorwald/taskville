import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createAnchorSource } from "../../host/anchors.ts";
import type { OverlayProps } from "../../host/types.ts";
import { SettingsPanel } from "../SettingsPanel.tsx";
import { createSettingsStore } from "../store.ts";
import { StrictAttributionSection } from "./StrictAttributionSection.tsx";

// M5.13: the "Strict teammate attribution" switch (decision #120 D2 as an option).
//
// Intended interface (apps/web/src/overlays/settings/attribution/StrictAttributionSection.tsx):
//   <StrictAttributionSection store?: SettingsStore />   // defaults to getSettingsStore()
// A react-aria `Switch` named "Strict teammate attribution" bound to `strictAttribution` in the
// settings store, with a line of help text. SettingsPanel mounts it (open panel body).
// Run: pnpm --filter @taskville/web test:browser src/overlays/settings/attribution

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const NAME = "Strict teammate attribution";

describe("StrictAttributionSection", () => {
  it("is off by default", async () => {
    await render(<StrictAttributionSection store={createSettingsStore(memoryStorage())} />);
    await expect.element(page.getByRole("switch", { name: NAME })).not.toBeChecked();
  });

  it("turns on and off, writing the setting to the store", async () => {
    const store = createSettingsStore(memoryStorage());
    await render(<StrictAttributionSection store={store} />);
    await page.getByRole("switch", { name: NAME }).click();
    await expect.element(page.getByRole("switch", { name: NAME })).toBeChecked();
    expect(store.getSnapshot().strictAttribution).toBe(true);
    await page.getByRole("switch", { name: NAME }).click();
    await expect.element(page.getByRole("switch", { name: NAME })).not.toBeChecked();
    expect(store.getSnapshot().strictAttribution).toBe(false);
  });

  it("stays on across a reload (a fresh store and section over the same storage)", async () => {
    const storage = memoryStorage();
    const first = await render(<StrictAttributionSection store={createSettingsStore(storage)} />);
    await page.getByRole("switch", { name: NAME }).click();
    await first.unmount();
    await render(<StrictAttributionSection store={createSettingsStore(storage)} />);
    await expect.element(page.getByRole("switch", { name: NAME })).toBeChecked();
  });

  it("follows a change made elsewhere in the same store", async () => {
    const store = createSettingsStore(memoryStorage());
    await render(<StrictAttributionSection store={store} />);
    store.set("strictAttribution", true);
    await expect.element(page.getByRole("switch", { name: NAME })).toBeChecked();
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

  it("shows the switch in its open body, off by default", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await page.getByRole("button", { name: "Settings" }).click();
    await expect.element(page.getByRole("switch", { name: NAME })).toBeVisible();
    await expect.element(page.getByRole("switch", { name: NAME })).not.toBeChecked();
  });
});
