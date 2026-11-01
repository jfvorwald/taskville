import { describe, expect, it } from "vitest";
import { createSoundscape } from "../../src/audio/soundscape.ts";
import { handoff, taskCompleted } from "../city/effects/events.ts";
import { fakeBackend, fakeLoader, fakeSettings, needsYou, settle } from "./fakes.ts";

// M4.09 review fix round: failed loads, the live chime path, idle cost (suspend), retry gating
// and event dedupe. Same shape as soundscape.test.ts: a real soundscape over a recording backend.

/** A soundscape whose loader the test settles by hand, for loads that are slow or fail. */
function manual(opts: { theme?: string; settings?: Parameters<typeof fakeSettings>[0] } = {}) {
  const fake = fakeBackend();
  const settings = fakeSettings(opts.settings);
  const loader = fakeLoader();
  const soundscape = createSoundscape({
    backend: fake.backend,
    settings,
    loadLoop: loader.loadLoop,
    theme: opts.theme ?? "cyberpunk",
  });
  return { ...fake, settings, loader, soundscape };
}

/** Enabled, with loads that resolve at once. */
async function enabled(
  opts: { theme?: string; settings?: Parameters<typeof fakeSettings>[0] } = {},
) {
  const fake = fakeBackend();
  const settings = fakeSettings(opts.settings);
  const loader = fakeLoader();
  const soundscape = createSoundscape({
    backend: fake.backend,
    settings,
    loadLoop: loader.instant,
    theme: opts.theme ?? "cyberpunk",
  });
  await soundscape.enable();
  await settle();
  return { ...fake, settings, loader, soundscape };
}

describe("a load that fails stops the loop it replaces", () => {
  it("stops the playing loop when the new theme's load rejects", async () => {
    const s = manual();
    await s.soundscape.enable();
    s.loader.resolve("cyberpunk");
    await settle();
    expect(s.playingLoop()).toBe("cyberpunk");

    s.soundscape.setTheme("steampunk");
    s.loader.reject("steampunk");
    await settle();
    expect(s.playingLoop()).toBeNull();
  });

  it("does not stop the current loop for a rejection whose load went stale", async () => {
    const s = manual();
    await s.soundscape.enable();
    s.loader.resolve("cyberpunk");
    await settle();

    s.soundscape.setTheme("steampunk");
    s.soundscape.setTheme("solarpunk"); // the viewer switched again before steampunk answered
    s.loader.resolve("solarpunk");
    await settle();
    expect(s.playingLoop()).toBe("solarpunk");

    s.loader.reject("steampunk");
    await settle();
    expect(s.playingLoop()).toBe("solarpunk");
  });
});

describe("chime() on the live path", () => {
  it("plays nothing while muted", async () => {
    const s = await enabled({ settings: { muted: true } });
    s.soundscape.chime();
    expect(s.cues()).toEqual([]);
  });

  it("plays under chime-only", async () => {
    const s = await enabled({ settings: { chimeOnly: true } });
    s.soundscape.chime();
    expect(s.cues("chime")).toHaveLength(1);
  });

  it("plays when neither muted nor chime-only, and stops once muted", async () => {
    const s = await enabled();
    s.soundscape.chime();
    expect(s.cues("chime")).toHaveLength(1);
    s.settings.patch({ muted: true });
    s.soundscape.chime();
    expect(s.cues("chime")).toHaveLength(1);
  });

  it("plays nothing before enable, in history mode, or after disable", async () => {
    const before = manual();
    before.soundscape.chime();
    expect(before.cues()).toEqual([]);

    const s = await enabled();
    s.soundscape.setHistory(true);
    s.soundscape.chime();
    s.soundscape.setHistory(false);
    s.soundscape.disable();
    s.soundscape.chime();
    expect(s.cues()).toEqual([]);
  });
});

describe("idle cost: park the audio context when nothing can sound", () => {
  it("suspends on disable, after cutting any ringing cue and stopping the loop", async () => {
    const s = await enabled();
    expect(s.suspends()).toHaveLength(0);
    s.soundscape.disable();
    expect(s.suspends()).toHaveLength(1);
    expect(s.lastIndex("suspend")).toBeGreaterThan(s.lastIndex("silence"));
    expect(s.lastIndex("suspend")).toBeGreaterThan(s.lastIndex("stopLoop"));
  });

  it("suspends when muted, once the loop has been stopped", async () => {
    const s = await enabled();
    s.settings.patch({ muted: true });
    expect(s.suspends()).toHaveLength(1);
    expect(s.lastIndex("suspend")).toBeGreaterThan(s.lastIndex("stopLoop"));
  });

  it("suspends right away when sound is enabled while muted", async () => {
    const s = await enabled({ settings: { muted: true } });
    expect(s.suspends()).toHaveLength(1);
    expect(s.lastIndex("suspend")).toBeGreaterThan(s.lastIndex("start"));
  });

  it("suspends under chime-only (no loop plays), and a chime still sounds", async () => {
    const s = await enabled({ settings: { chimeOnly: true } });
    expect(s.suspends()).toHaveLength(1);
    s.soundscape.update([needsYou("a1")]);
    expect(s.cues("chime")).toHaveLength(1);
  });

  it("does not suspend while a loop is playing or still loading", async () => {
    const s = manual();
    await s.soundscape.enable();
    expect(s.suspends()).toHaveLength(0); // wanted, still loading
    s.loader.resolve("cyberpunk");
    await settle();
    s.settings.patch({ volume: 0.9 });
    s.soundscape.update([needsYou("a1")]);
    s.soundscape.handleEvent(taskCompleted("a1"));
    expect(s.suspends()).toHaveLength(0);
  });

  it("resumes the context before the loop returns after unmuting", async () => {
    const s = await enabled();
    s.settings.patch({ muted: true });
    expect(s.suspends()).toHaveLength(1);
    s.settings.patch({ muted: false });
    await settle();
    expect(s.lastIndex("start")).toBeGreaterThan(s.lastIndex("suspend"));
    expect(s.lastIndex("startLoop")).toBeGreaterThan(s.lastIndex("start"));
    expect(s.playingLoop()).toBe("cyberpunk");
  });

  it("resumes the context before the loop returns after leaving chime-only", async () => {
    const s = await enabled({ settings: { chimeOnly: true } });
    expect(s.suspends()).toHaveLength(1);
    s.settings.patch({ chimeOnly: false });
    await settle();
    expect(s.lastIndex("start")).toBeGreaterThan(s.lastIndex("suspend"));
    expect(s.lastIndex("startLoop")).toBeGreaterThan(s.lastIndex("start"));
  });

  it("starts the backend again when sound is re-enabled after disable", async () => {
    const s = await enabled();
    s.soundscape.disable();
    await s.soundscape.enable();
    expect(s.calls.filter((c) => c.op === "start")).toHaveLength(2);
  });
});

describe("a loop that failed to load is not retried by unrelated settings", () => {
  async function failed() {
    const s = manual();
    await s.soundscape.enable();
    expect(s.loader.requested).toEqual(["cyberpunk"]);
    s.loader.reject("cyberpunk");
    await settle();
    return s;
  }

  it("does not retry when only the volume changes", async () => {
    const s = await failed();
    s.settings.patch({ volume: 0.9 });
    await settle();
    s.settings.patch({ volume: 0.2 });
    await settle();
    expect(s.loader.requested).toEqual(["cyberpunk"]);
    expect(s.playingLoop()).toBeNull();
  });

  it("retries when the theme changes", async () => {
    const s = await failed();
    s.soundscape.setTheme("steampunk");
    expect(s.loader.requested).toEqual(["cyberpunk", "steampunk"]);
    s.loader.resolve("steampunk");
    await settle();
    expect(s.playingLoop()).toBe("steampunk");
  });

  it("retries when unmuted", async () => {
    const s = await failed();
    s.settings.patch({ muted: true });
    s.settings.patch({ muted: false });
    expect(s.loader.requested).toEqual(["cyberpunk", "cyberpunk"]);
    s.loader.resolve("cyberpunk");
    await settle();
    expect(s.playingLoop()).toBe("cyberpunk");
  });
});

describe("an event is recorded once even when it arrives while muted", () => {
  it("stays silent when redelivered after unmute", async () => {
    const s = await enabled();
    const done = taskCompleted("a1");
    const pass = handoff("a1", "a2");

    s.settings.patch({ muted: true });
    s.soundscape.handleEvent(done);
    s.soundscape.handleEvent(pass);
    s.settings.patch({ muted: false });
    s.soundscape.handleEvent(done);
    s.soundscape.handleEvent(pass);
    expect(s.cues()).toEqual([]);

    // A genuinely new event after the unmute still sounds.
    s.soundscape.handleEvent(taskCompleted("a2"));
    expect(s.cues("tick")).toHaveLength(1);
  });
});
