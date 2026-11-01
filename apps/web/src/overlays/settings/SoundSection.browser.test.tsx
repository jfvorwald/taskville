import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { createSoundSettingsStore, type Soundscape } from "../../audio/index.ts";
import { SoundSection } from "./SoundSection.tsx";

// M4.09: the Sound controls in the settings panel. The soundscape is a recording fake, so no
// AudioContext is created; what matters is that enable() runs from the click (browsers only let
// audio start from a gesture) and that the three settings are remembered under taskville.audio.*.

function memoryStorage() {
  const data = new Map<string, string>();
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
    data,
  };
}

function fakeSoundscape() {
  const log = {
    enableCalls: 0,
    /** navigator.userActivation.isActive at the moment enable() ran: true inside a click. */
    activeDuringEnable: [] as boolean[],
    disableCalls: 0,
  };
  let enabled = false;
  const soundscape: Soundscape = {
    get enabled() {
      return enabled;
    },
    enable() {
      log.enableCalls += 1;
      log.activeDuringEnable.push(navigator.userActivation.isActive);
      enabled = true;
      return Promise.resolve();
    },
    disable() {
      log.disableCalls += 1;
      enabled = false;
    },
    update() {},
    handleEvent() {},
    setTheme() {},
    setHistory() {},
  };
  return { soundscape, log };
}

describe("SoundSection", () => {
  it("starts off: nothing is enabled until Enable sound is pressed", async () => {
    const { soundscape, log } = fakeSoundscape();
    await render(
      <SoundSection soundscape={soundscape} store={createSoundSettingsStore(memoryStorage())} />,
    );
    await expect.element(page.getByRole("button", { name: "Enable sound" })).toBeVisible();
    expect(log.enableCalls).toBe(0);
    expect(soundscape.enabled).toBe(false);
  });

  it("calls the soundscape's enable() from the click on Enable sound", async () => {
    const { soundscape, log } = fakeSoundscape();
    await render(
      <SoundSection soundscape={soundscape} store={createSoundSettingsStore(memoryStorage())} />,
    );
    await page.getByRole("button", { name: "Enable sound" }).click();
    expect(log.enableCalls).toBe(1);
    // Inside the click's activation window, which is what lets the browser start audio.
    expect(log.activeDuringEnable).toEqual([true]);
    await expect.element(page.getByRole("button", { name: "Turn sound off" })).toBeVisible();
  });

  it("turns sound off again with disable()", async () => {
    const { soundscape, log } = fakeSoundscape();
    await render(
      <SoundSection soundscape={soundscape} store={createSoundSettingsStore(memoryStorage())} />,
    );
    await page.getByRole("button", { name: "Enable sound" }).click();
    await page.getByRole("button", { name: "Turn sound off" }).click();
    expect(log.disableCalls).toBe(1);
    expect(soundscape.enabled).toBe(false);
    await expect.element(page.getByRole("button", { name: "Enable sound" })).toBeVisible();
  });

  it("shows the defaults: half volume, not muted, not chime only", async () => {
    const { soundscape } = fakeSoundscape();
    await render(
      <SoundSection soundscape={soundscape} store={createSoundSettingsStore(memoryStorage())} />,
    );
    const volume = page.getByRole("slider", { name: "Volume" });
    await expect.element(volume).toHaveValue("0.5");
    await expect.element(page.getByRole("switch", { name: "Mute" })).not.toBeChecked();
    await expect.element(page.getByRole("switch", { name: "Chime only" })).not.toBeChecked();
  });

  it("writes volume, mute and chime only to the store under taskville.audio.*", async () => {
    const { soundscape } = fakeSoundscape();
    const storage = memoryStorage();
    const store = createSoundSettingsStore(storage);
    await render(<SoundSection soundscape={soundscape} store={store} />);

    (page.getByRole("slider", { name: "Volume" }).element() as HTMLInputElement).focus();
    await userEvent.keyboard("{ArrowRight}");
    expect(store.getSnapshot().volume).toBeCloseTo(0.55, 5);
    expect(JSON.parse(storage.data.get("taskville.audio.volume") ?? "null")).toBeCloseTo(0.55, 5);

    await page.getByText("Mute", { exact: true }).click();
    expect(store.getSnapshot().muted).toBe(true);
    expect(storage.data.get("taskville.audio.muted")).toBe("true");

    await page.getByText("Chime only", { exact: true }).click();
    expect(store.getSnapshot().chimeOnly).toBe(true);
    expect(storage.data.get("taskville.audio.chimeOnly")).toBe("true");
  });

  it("keeps volume, mute and chime only across a reload", async () => {
    const storage = memoryStorage();
    const { soundscape } = fakeSoundscape();
    const first = await render(
      <SoundSection soundscape={soundscape} store={createSoundSettingsStore(storage)} />,
    );
    (page.getByRole("slider", { name: "Volume" }).element() as HTMLInputElement).focus();
    await userEvent.keyboard("{ArrowLeft}{ArrowLeft}");
    await page.getByText("Mute", { exact: true }).click();
    await page.getByText("Chime only", { exact: true }).click();
    await first.unmount();

    // A reload: a fresh store and a fresh section over the same storage. Sound itself is off again.
    const again = fakeSoundscape();
    await render(
      <SoundSection soundscape={again.soundscape} store={createSoundSettingsStore(storage)} />,
    );
    await expect.element(page.getByRole("slider", { name: "Volume" })).toHaveValue("0.4");
    await expect.element(page.getByRole("switch", { name: "Mute" })).toBeChecked();
    await expect.element(page.getByRole("switch", { name: "Chime only" })).toBeChecked();
    await expect.element(page.getByRole("button", { name: "Enable sound" })).toBeVisible();
    expect(again.log.enableCalls).toBe(0);
  });
});
