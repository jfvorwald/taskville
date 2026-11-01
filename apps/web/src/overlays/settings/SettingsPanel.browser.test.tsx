import { afterEach, beforeEach, describe, expect, it } from "vitest";
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

  // M4.01: desktop notifications are opt-in, a switch that is off until the viewer turns it on.
  it("offers a Desktop notifications switch that is off by default and is not disabled", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await openPanel();
    const toggle = page.getByRole("switch", { name: "Desktop notifications" });
    await expect.element(toggle).toBeVisible();
    await expect.element(toggle).not.toBeChecked();
    await expect.element(toggle).not.toBeDisabled();
  });

  it("turns Desktop notifications on, writes it to the store, and keeps it across a reload", async () => {
    const storage = memoryStorage();
    const store = createSettingsStore(storage);
    const first = await render(<SettingsPanel {...overlayProps} store={store} />);
    await openPanel();
    // The switch's input is visually hidden; a viewer clicks its label.
    await page.getByText("Desktop notifications", { exact: true }).click();
    expect(store.getSnapshot().desktopNotifications).toBe(true);
    await first.unmount();

    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(storage)} />);
    await openPanel();
    await expect.element(page.getByRole("switch", { name: "Desktop notifications" })).toBeChecked();
  });

  it("shows code privacy as a disabled placeholder", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await openPanel();
    await expect
      .element(page.getByRole("switch", { name: "Hide code in the city" }))
      .toBeDisabled();
  });

  // M4.09: the Sound section replaces the old disabled "Sound / Coming later" switch.
  it("has a Sound section with Enable sound, volume, Mute and Chime only, all off by default", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await openPanel();
    await expect.element(page.getByRole("group", { name: "Sound" })).toBeVisible();
    const enable = page.getByRole("button", { name: "Enable sound" });
    await expect.element(enable).toBeVisible();
    await expect.element(enable).not.toBeDisabled();
    await expect.element(page.getByRole("slider", { name: "Volume" })).toBeVisible();
    const mute = page.getByRole("switch", { name: "Mute" });
    await expect.element(mute).toBeVisible();
    await expect.element(mute).not.toBeChecked();
    const chimeOnly = page.getByRole("switch", { name: "Chime only" });
    await expect.element(chimeOnly).toBeVisible();
    await expect.element(chimeOnly).not.toBeChecked();
    // Off until pressed: the button offers to enable, not to turn off.
    await expect
      .element(page.getByRole("button", { name: "Turn sound off" }))
      .not.toBeInTheDocument();
  });

  it("no longer offers the disabled Sound switch marked Coming later", async () => {
    await render(<SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />);
    await openPanel();
    await expect
      .element(page.getByRole("switch", { name: "Sound", exact: true }))
      .not.toBeInTheDocument();
    await expect.element(page.getByRole("switch", { name: /sound/i })).not.toBeInTheDocument();
    // Only code privacy is still coming later.
    expect(page.getByText("Coming later").elements()).toHaveLength(1);
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
  it.each([["Hide code in the city", /hide code/i]])(
    "tells assistive tech that the %s switch is coming later",
    async (_label, name) => {
      await render(
        <SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />,
      );
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
        ? [input.getAttribute("aria-label"), textOf(input.getAttribute("aria-describedby"))].join(
            " ",
          )
        : accessible;
      expect(named).toMatch(/coming later/i);
    },
  );
});

// roborev 5624 #2: the sidebar slot is the viewport minus 64px above and 16px below, and the host
// clips what overflows it. At a short viewport the expanded panel must scroll inside the slot, not
// run past it, or the lower controls cannot be reached.
describe("SettingsPanel in a short sidebar", () => {
  const SLOT_TOP = 64;
  const SLOT_BOTTOM = 16;
  let restore: { width: number; height: number };

  beforeEach(async () => {
    restore = { width: window.innerWidth, height: window.innerHeight };
    await page.viewport(800, 480);
  });

  afterEach(async () => {
    await page.viewport(restore.width, restore.height);
  });

  it("keeps the last control reachable by scrolling a container inside the slot", async () => {
    // The overlay host's sidebar slot: absolutely placed, clipping (host.module.css).
    const slot = document.createElement("div");
    slot.style.cssText = `position:absolute;top:${SLOT_TOP}px;right:16px;bottom:${SLOT_BOTTOM}px;width:360px;overflow:hidden;`;
    document.body.appendChild(slot);
    try {
      await render(
        <SettingsPanel {...overlayProps} store={createSettingsStore(memoryStorage())} />,
        { container: slot },
      );
      await openPanel();

      const last = page.getByRole("switch", { name: "Hide code in the city" }).element();
      const slotBox = slot.getBoundingClientRect();
      expect(slotBox.height).toBe(480 - SLOT_TOP - SLOT_BOTTOM);

      // Some container between the last control and the slot must scroll, and fit inside the slot.
      let scroller: HTMLElement | null = last.parentElement;
      while (scroller && scroller !== slot) {
        const overflowY = getComputedStyle(scroller).overflowY;
        if (overflowY === "auto" || overflowY === "scroll") break;
        scroller = scroller.parentElement;
      }
      expect(scroller, "a scroll container (overflow-y auto) inside the sidebar slot").not.toBe(
        slot,
      );
      expect(scroller).not.toBeNull();
      const box = (scroller as HTMLElement).getBoundingClientRect();
      expect(box.top).toBeGreaterThanOrEqual(slotBox.top);
      expect(box.bottom).toBeLessThanOrEqual(slotBox.bottom + 0.5);

      // Scrolled into view, the last control sits inside the scroller and so inside the slot. The
      // visible control is the switch's label; its input is visually hidden and its box can sit
      // below the label, so it is not what a viewer reaches (M4.01 added a switch above, which
      // made the panel scroll for the first time at this height).
      const control = last.closest("label") ?? last;
      control.scrollIntoView({ block: "end" });
      const lastBox = control.getBoundingClientRect();
      expect(lastBox.top).toBeGreaterThanOrEqual(box.top - 0.5);
      expect(lastBox.bottom).toBeLessThanOrEqual(box.bottom + 0.5);
    } finally {
      slot.remove();
    }
  });
});
