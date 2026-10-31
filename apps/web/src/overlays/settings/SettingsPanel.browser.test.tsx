import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createAnchorSource } from "../host/anchors.ts";
import type { OverlayProps } from "../host/types.ts";
import { SettingsPanel, settingsOverlay } from "./SettingsPanel.tsx";
import { createSettingsStore } from "./store.ts";

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

const overlayProps: OverlayProps = {
  mode: "live",
  selectors: { counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) } },
  selection: { selectedId: null, select: () => {} },
  anchors: createAnchorSource(),
  intents: { available: true, run: () => {} },
  settings: { get: (_k, f) => f, set: () => {} },
};

async function openPanel() {
  await page.getByRole("button", { name: "Settings" }).click();
}

describe("SettingsPanel", () => {
  it("is a sidebar overlay available in both modes", () => {
    expect(settingsOverlay).toMatchObject({ id: "settings-panel", slot: "sidebar" });
    expect(settingsOverlay.modes).toEqual(["live", "history"]);
  });

  it("is collapsed until the Settings button is pressed", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await expect.element(page.getByRole("button", { name: "Settings" })).toHaveAttribute("aria-expanded", "false");
    await expect.element(page.getByRole("radiogroup", { name: "Day and night" })).not.toBeInTheDocument();
    await openPanel();
    await expect.element(page.getByRole("radiogroup", { name: "Day and night" })).toBeVisible();
  });

  it("shows the defaults", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await openPanel();
    await expect.element(page.getByRole("radio", { name: "Auto" })).toBeChecked();
    await expect.element(page.getByRole("radio", { name: "Follow system" })).toBeChecked();
    await expect.element(page.getByRole("radio", { name: "Cyberpunk" })).toBeChecked();
  });

  it("persists the chosen settings across a reload", async () => {
    const storage = memoryStorage();
    const first = await render(<SettingsPanel {...overlayProps} store={createSettingsStore(storage)} />);
    await openPanel();
    await page.getByRole("radio", { name: "Night" }).click();
    await page.getByRole("radio", { name: "Reduce" }).click();
    await first.unmount();

    // A reload: a fresh store and a fresh panel over the same storage.
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(storage)} />);
    await openPanel();
    await expect.element(page.getByRole("radio", { name: "Night" })).toBeChecked();
    await expect.element(page.getByRole("radio", { name: "Reduce" })).toBeChecked();
  });

  it("writes through to the store that the theme and lighting systems read", async () => {
    const store = createSettingsStore(memoryStorage());
    await render(<SettingsPanel {...overlayProps} store={store} />);
    await openPanel();
    await page.getByRole("radio", { name: "Day" }).click();
    expect(store.getSnapshot().dayNight).toBe("day");
  });

  it("changes a choice from the keyboard", async () => {
    const store = createSettingsStore(memoryStorage());
    await render(<SettingsPanel {...overlayProps} store={store} />);
    await openPanel();
    await page.getByRole("radio", { name: "Auto" }).click();
    await page.getByRole("radio", { name: "Auto" }).element().focus();
    await page.keyboard.press("ArrowRight");
    expect(store.getSnapshot().dayNight).toBe("day");
  });

  it("shows sound and code privacy as disabled placeholders", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await openPanel();
    await expect.element(page.getByRole("switch", { name: "Sound" })).toBeDisabled();
    await expect.element(page.getByRole("switch", { name: "Hide code in the city" })).toBeDisabled();
  });
});
