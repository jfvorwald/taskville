import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createAnchorSource } from "../overlays/host/anchors.ts";
import type { OverlayProps } from "../overlays/host/types.ts";
import { THEMES, themeController } from "../themes/core/index.ts";
import { themedSettingsOverlay } from "./themedSettingsOverlay.tsx";

// The app registers one theme today, which the panel's own placeholder list also shows. A second
// registered theme tells the registry's list from the placeholder.
vi.mock("../themes/core/themes.ts", async () => {
  const { createThemeController } = await import("../themes/core/controller.ts");
  const { cyberpunkTheme } = await import("../themes/cyberpunk/index.ts");
  const steampunkTheme = { ...cyberpunkTheme, id: "steampunk" as const, name: "Steampunk" };
  const THEMES = [cyberpunkTheme, steampunkTheme];
  return { THEMES, themeController: createThemeController({ themes: THEMES }) };
});

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

describe("themedSettingsOverlay", () => {
  it("keeps the settings overlay's identity and slot", () => {
    expect(themedSettingsOverlay).toMatchObject({ id: "settings-panel", slot: "sidebar" });
  });

  it("offers one theme radio per registered theme, named after the theme", async () => {
    const { Component } = themedSettingsOverlay;
    await render(<Component {...overlayProps} />);
    await page.getByRole("button", { name: "Settings" }).click();

    const group = page.getByRole("radiogroup", { name: "Theme" });
    await expect.element(group).toBeVisible();
    expect(THEMES.length).toBeGreaterThan(1);
    for (const theme of THEMES) {
      await expect.element(group.getByRole("radio", { name: theme.name })).toBeVisible();
    }
    expect(group.getByRole("radio").elements()).toHaveLength(THEMES.length);
  });
});

// roborev 5636 #2: with ?theme=steampunk the city shows steampunk while the stored theme setting
// stays cyberpunk. The panel must show the theme in use, and choosing any theme must apply it,
// including the one the stored setting already names.
describe("themedSettingsOverlay: a theme in use that differs from the stored one", () => {
  beforeEach(() => {
    localStorage.clear();
    themeController.setTheme("cyberpunk");
  });

  afterEach(() => {
    themeController.setTheme("cyberpunk");
    localStorage.clear();
  });

  it("marks the theme in use, not the stored theme", async () => {
    themeController.setTheme("steampunk"); // what ?theme=steampunk does; nothing is stored
    const { Component } = themedSettingsOverlay;
    await render(<Component {...overlayProps} />);
    await page.getByRole("button", { name: "Settings" }).click();

    await expect.element(page.getByRole("radio", { name: "Steampunk" })).toBeChecked();
    await expect.element(page.getByRole("radio", { name: "Cyberpunk" })).not.toBeChecked();
  });

  it("switches back to the stored theme when it is chosen", async () => {
    themeController.setTheme("steampunk");
    const { Component } = themedSettingsOverlay;
    await render(<Component {...overlayProps} />);
    await page.getByRole("button", { name: "Settings" }).click();

    await page.getByText("Cyberpunk", { exact: true }).click();
    expect(themeController.store.getState().themeId).toBe("cyberpunk");
  });
});
