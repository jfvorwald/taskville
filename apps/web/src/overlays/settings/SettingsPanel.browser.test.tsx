import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
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
  selectors: {
    counts: { subscribe: () => () => {}, getSnapshot: () => ({ active: 0, needsYou: 0 }) },
  },
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
    await expect
      .element(page.getByRole("button", { name: "Settings" }))
      .toHaveAttribute("aria-expanded", "false");
    await expect
      .element(page.getByRole("radiogroup", { name: "Day and night" }))
      .not.toBeInTheDocument();
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
    const first = await render(
      <SettingsPanel {...overlayProps} store={createSettingsStore(storage)} />,
    );
    await openPanel();
    await page.getByText("Night", { exact: true }).click();
    await page.getByText("Reduce", { exact: true }).click();
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
    await page.getByText("Day", { exact: true }).click();
    expect(store.getSnapshot().dayNight).toBe("day");
  });

  it("changes a choice from the keyboard", async () => {
    const store = createSettingsStore(memoryStorage());
    await render(<SettingsPanel {...overlayProps} store={store} />);
    await openPanel();
    await page.getByText("Auto", { exact: true }).click();
    await userEvent.keyboard("{ArrowRight}");
    expect(store.getSnapshot().dayNight).toBe("day");
  });

  it("shows sound and code privacy as disabled placeholders", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await openPanel();
    await expect.element(page.getByRole("switch", { name: "Sound" })).toBeDisabled();
    await expect
      .element(page.getByRole("switch", { name: "Hide code in the city" }))
      .toBeDisabled();
  });
  // Finding 2: a stored theme id that the themes list does not contain must not leave the radio
  // group with nothing checked; the theme system falls back to the default, so the panel shows it.
  it("checks the default theme when the stored theme is not in the themes list", async () => {
    const storage = memoryStorage();
    storage.setItem("taskville.overlay.settings-panel.theme", '"nope"');
    const themes = [
      { id: "cyberpunk", label: "Cyberpunk" },
      { id: "neon", label: "Neon" },
    ];
    await render(
      <SettingsPanel {...overlayProps} store={createSettingsStore(storage)} themes={themes} />,
    );
    await openPanel();
    await expect.element(page.getByRole("radio", { name: "Cyberpunk" })).toBeChecked();
    await expect.element(page.getByRole("radio", { name: "Neon" })).not.toBeChecked();
  });

  // Finding 5: the visible "Coming later" note must survive into the accessible name or description.
  it.each([
    ["Sound", /sound/i],
    ["Hide code in the city", /hide code/i],
  ])("tells assistive tech that the %s switch is coming later", async (_label, name) => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await openPanel();
    const sw = page.getByRole("switch", { name });
    await expect.element(sw).toBeDisabled();
    const input = sw.element() as HTMLInputElement;
    const textOf = (ids: string | null) =>
      (ids ?? "")
        .split(/\s+/)
        .map((id) => document.getElementById(id)?.textContent ?? "")
        .join(" ");
    const accessible = [
      input.getAttribute("aria-label"),
      textOf(input.getAttribute("aria-labelledby")),
      textOf(input.getAttribute("aria-describedby")),
      ...Array.from(input.labels ?? []).map((l) => l.textContent),
    ].join(" ");
    // aria-label replaces label content in the accessible name, so only count labels when it is absent.
    const named = input.getAttribute("aria-label")
      ? [input.getAttribute("aria-label"), textOf(input.getAttribute("aria-describedby"))].join(" ")
      : accessible;
    expect(named).toMatch(/coming later/i);
  });
});
