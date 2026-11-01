import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createAnchorSource } from "../overlays/host/anchors.ts";
import type { OverlayProps } from "../overlays/host/types.ts";
import { THEMES } from "../themes/core/index.ts";
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
