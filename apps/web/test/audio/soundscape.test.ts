import { describe, expect, it } from "vitest";
import { createSoundscape } from "../../src/audio/soundscape.ts";
import { handoff, taskCompleted, taskRunning } from "../city/effects/events.ts";
import {
  fakeBackend,
  fakeLoader,
  fakeSettings,
  needsYou,
  needsYouFromTelemetry,
  settle,
  trouble,
  waiting,
} from "./fakes.ts";

// ARCHITECTURE.md 2.7. The core takes an injected backend and loader, so none of these tests
// touches a real AudioContext. Chime policy chosen here: ONE combined chime per update() call,
// however many agents entered needs-you in that update (constitution VII: calm).

function setup(opts: { theme?: string; settings?: Parameters<typeof fakeSettings>[0] } = {}) {
  const fake = fakeBackend();
  const settings = fakeSettings(opts.settings);
  const loader = fakeLoader();
  const soundscape = createSoundscape({
    backend: fake.backend,
    settings,
    loadLoop: loader.instant,
    theme: opts.theme ?? "cyberpunk",
  });
  return { ...fake, settings, loader, soundscape };
}

/** A soundscape that is enabled and has finished its enable-time setup (loop started). */
async function enabled(opts: Parameters<typeof setup>[0] = {}) {
  const s = setup(opts);
  await s.soundscape.enable();
  await settle();
  s.loader.requested.length = 0;
  return s;
}

/** Forget what the backend has been asked so far, keeping the playing loop knowledge simple. */
const sinceNow = (s: Awaited<ReturnType<typeof enabled>>) => s.calls.length;

describe("nothing plays before enable", () => {
  it("is off by default and does not touch the backend or the loader", async () => {
    const s = setup();
    expect(s.soundscape.enabled).toBe(false);

    s.soundscape.update([needsYou("a1")]);
    s.soundscape.handleEvent(taskCompleted("a1"));
    s.soundscape.handleEvent(handoff("a1", "a2"));
    s.soundscape.setTheme("steampunk");
    s.settings.patch({ volume: 0.9, muted: false });
    s.soundscape.setHistory(true);
    s.soundscape.setHistory(false);
    await settle();

    expect(s.calls).toEqual([]);
    expect(s.loader.requested).toEqual([]);
    expect(s.soundscape.enabled).toBe(false);
  });

  it("starts the backend only when enable() is called, and only once", async () => {
    const s = setup();
    await s.soundscape.enable();
    await s.soundscape.enable();
    expect(s.calls.filter((c) => c.op === "start")).toHaveLength(1);
    expect(s.soundscape.enabled).toBe(true);
  });

  it("applies the master volume once enabled", async () => {
    const s = setup({ settings: { volume: 0.4 } });
    await s.soundscape.enable();
    expect(s.lastVolume()).toBe(0.4);
  });

  it("does not chime for an agent that was already waiting when sound was enabled", async () => {
    const s = setup();
    s.soundscape.update([needsYou("a1")]);
    await s.soundscape.enable();
    await settle();
    s.soundscape.update([needsYou("a1")]);
    expect(s.cues()).toEqual([]);
  });

  it("stops everything when disabled", async () => {
    const s = await enabled();
    s.soundscape.disable();
    expect(s.soundscape.enabled).toBe(false);
    expect(s.playingLoop()).toBeNull();

    const mark = sinceNow(s);
    s.soundscape.update([needsYou("a1")]);
    s.soundscape.handleEvent(taskCompleted("a1"));
    expect(s.calls.slice(mark).filter((c) => c.op === "playCue")).toEqual([]);
  });
});

describe("chime once per needs-you start", () => {
  it("chimes exactly once when an agent enters needs-you", async () => {
    const s = await enabled();
    s.soundscape.update([]);
    s.soundscape.update([needsYou("a1")]);
    expect(s.cues("chime")).toHaveLength(1);
    expect(s.cues()).toHaveLength(1);
  });

  it("does not re-chime while the agent stays in needs-you across updates", async () => {
    const s = await enabled();
    const record = needsYou("a1", "r1");
    s.soundscape.update([record]);
    s.soundscape.update([record]);
    s.soundscape.update([{ ...record }]);
    expect(s.cues("chime")).toHaveLength(1);
  });

  it("does not re-chime when a requestId swap replaces telemetry for the same agent", async () => {
    const s = await enabled();
    s.soundscape.update([needsYouFromTelemetry("a1")]);
    expect(s.cues("chime")).toHaveLength(1);

    // The bridge request arrives: same agent, one prompt, one red state (ARCHITECTURE 2.2).
    s.soundscape.update([needsYou("a1", "bridge-req-1")]);
    s.soundscape.update([needsYou("a1", "bridge-req-2")]);
    expect(s.cues("chime")).toHaveLength(1);
  });

  it("counts an agent with two needs-you records as one start", async () => {
    const s = await enabled();
    s.soundscape.update([needsYou("a1", "r1"), needsYou("a1", "r2")]);
    expect(s.cues("chime")).toHaveLength(1);
  });

  it("chimes again when the agent leaves needs-you and re-enters", async () => {
    const s = await enabled();
    s.soundscape.update([needsYou("a1")]);
    s.soundscape.update([]);
    s.soundscape.update([needsYou("a1")]);
    expect(s.cues("chime")).toHaveLength(2);
  });

  it("treats a drop to trouble as leaving needs-you", async () => {
    const s = await enabled();
    s.soundscape.update([needsYou("a1")]);
    s.soundscape.update([trouble("a1")]);
    s.soundscape.update([needsYou("a1")]);
    expect(s.cues("chime")).toHaveLength(2);
  });

  it("does not chime for trouble or waiting records", async () => {
    const s = await enabled();
    s.soundscape.update([trouble("a1"), waiting("a2")]);
    expect(s.cues()).toEqual([]);
  });

  it("plays one combined chime when several agents enter needs-you in one update", async () => {
    const s = await enabled();
    s.soundscape.update([needsYou("a1"), needsYou("a2"), needsYou("a3")]);
    expect(s.cues("chime")).toHaveLength(1);
  });

  it("chimes for a newcomer while another agent is still red, but not for the old one", async () => {
    const s = await enabled();
    s.soundscape.update([needsYou("a1")]);
    s.soundscape.update([needsYou("a1"), needsYou("a2")]);
    expect(s.cues("chime")).toHaveLength(2);
    s.soundscape.update([needsYou("a2")]);
    expect(s.cues("chime")).toHaveLength(2);
  });
});

describe("completion tick and handoff pop", () => {
  it("ticks on a recorded task completion", async () => {
    const s = await enabled();
    s.soundscape.handleEvent(taskCompleted("a1"));
    expect(s.cues("tick")).toHaveLength(1);
    expect(s.cues()).toHaveLength(1);
  });

  it("pops on a recorded handoff", async () => {
    const s = await enabled();
    s.soundscape.handleEvent(handoff("a1", "a2"));
    expect(s.cues("pop")).toHaveLength(1);
    expect(s.cues()).toHaveLength(1);
  });

  it("stays silent for events that are not completions or handoffs", async () => {
    const s = await enabled();
    s.soundscape.handleEvent(taskRunning("a1"));
    expect(s.cues()).toEqual([]);
  });

  it("plays nothing for imported or late events (same rule as celebrations)", async () => {
    const s = await enabled();
    s.soundscape.handleEvent({ ...taskCompleted("a1"), provenance: "imported" });
    s.soundscape.handleEvent({ ...handoff("a1", "a2"), late: true });
    expect(s.cues()).toEqual([]);
  });

  it("plays a recorded event once even if it is delivered twice", async () => {
    const s = await enabled();
    const event = taskCompleted("a1");
    s.soundscape.handleEvent(event);
    s.soundscape.handleEvent(event);
    expect(s.cues("tick")).toHaveLength(1);
  });
});

describe("master volume, mute and chime-only", () => {
  it("scales the backend gain with master volume, including later changes", async () => {
    const s = await enabled({ settings: { volume: 0.5 } });
    s.settings.patch({ volume: 0.2 });
    expect(s.lastVolume()).toBe(0.2);
    s.settings.patch({ volume: 1 });
    expect(s.lastVolume()).toBe(1);
  });

  it("clamps a volume outside 0 to 1", async () => {
    const s = await enabled();
    s.settings.patch({ volume: 3 });
    expect(s.lastVolume()).toBe(1);
    s.settings.patch({ volume: -1 });
    expect(s.lastVolume()).toBe(0);
  });

  it("plays nothing while muted, and stops the ambient loop", async () => {
    const s = await enabled();
    expect(s.playingLoop()).toBe("cyberpunk");
    s.settings.patch({ muted: true });
    expect(s.playingLoop()).toBeNull();

    s.soundscape.update([needsYou("a1")]);
    s.soundscape.handleEvent(taskCompleted("a1"));
    s.soundscape.handleEvent(handoff("a1", "a2"));
    expect(s.cues()).toEqual([]);
  });

  it("resumes the ambient loop when unmuted", async () => {
    const s = await enabled();
    s.settings.patch({ muted: true });
    s.settings.patch({ muted: false });
    await settle();
    expect(s.playingLoop()).toBe("cyberpunk");
  });

  it("does not chime later for a needs-you start that happened while muted", async () => {
    const s = await enabled();
    s.settings.patch({ muted: true });
    s.soundscape.update([needsYou("a1")]);
    s.settings.patch({ muted: false });
    s.soundscape.update([needsYou("a1")]);
    expect(s.cues()).toEqual([]);
  });

  it("chime-only plays chimes but no ambient, ticks or pops", async () => {
    const s = await enabled({ settings: { chimeOnly: true } });
    expect(s.playingLoop()).toBeNull();

    s.soundscape.update([needsYou("a1")]);
    s.soundscape.handleEvent(taskCompleted("a1"));
    s.soundscape.handleEvent(handoff("a1", "a2"));
    expect(s.cues("chime")).toHaveLength(1);
    expect(s.cues("tick")).toHaveLength(0);
    expect(s.cues("pop")).toHaveLength(0);
  });

  it("chime-only at runtime stops the loop; leaving it brings the loop back", async () => {
    const s = await enabled();
    s.settings.patch({ chimeOnly: true });
    expect(s.playingLoop()).toBeNull();
    s.settings.patch({ chimeOnly: false });
    await settle();
    expect(s.playingLoop()).toBe("cyberpunk");
  });

  it("does not even load the ambient asset in chime-only mode", async () => {
    const s = setup({ settings: { chimeOnly: true } });
    await s.soundscape.enable();
    await settle();
    expect(s.loader.requested).toEqual([]);
  });
});

describe("per-theme ambient loop, lazy-loaded after enable", () => {
  it("loads the current theme's loop only after enable, then starts it", async () => {
    const s = setup({ theme: "steampunk" });
    expect(s.loader.requested).toEqual([]);
    await s.soundscape.enable();
    await settle();
    expect(s.loader.requested).toEqual(["steampunk"]);
    expect(s.loops()).toEqual([
      { op: "startLoop", themeId: "steampunk", asset: "asset:steampunk" },
    ]);
  });

  it("swaps the loop when the theme changes, loading the new theme on demand", async () => {
    const s = await enabled({ theme: "cyberpunk" });
    s.soundscape.setTheme("solarpunk");
    await settle();
    expect(s.loader.requested).toEqual(["solarpunk"]);
    expect(s.playingLoop()).toBe("solarpunk");
  });

  it("ignores setTheme to the theme already playing", async () => {
    const s = await enabled({ theme: "cyberpunk" });
    const mark = sinceNow(s);
    s.soundscape.setTheme("cyberpunk");
    await settle();
    expect(s.loader.requested).toEqual([]);
    expect(s.calls.slice(mark)).toEqual([]);
  });

  it("does not start a stale loop when the theme changed again while it was loading", async () => {
    const fake = fakeBackend();
    const loader = fakeLoader();
    const soundscape = createSoundscape({
      backend: fake.backend,
      settings: fakeSettings(),
      loadLoop: loader.loadLoop,
      theme: "cyberpunk",
    });
    const enabling = soundscape.enable();
    await settle();
    soundscape.setTheme("steampunk");
    await settle();
    loader.resolve("steampunk");
    loader.resolve("cyberpunk"); // the slow first request lands last
    await enabling;
    await settle();
    expect(fake.playingLoop()).toBe("steampunk");
    expect(fake.loops().map((c) => c.themeId)).not.toContain("cyberpunk");
  });

  it("remembers the theme chosen before enable", async () => {
    const s = setup({ theme: "cyberpunk" });
    s.soundscape.setTheme("aero");
    await s.soundscape.enable();
    await settle();
    expect(s.loader.requested).toEqual(["aero"]);
    expect(s.playingLoop()).toBe("aero");
  });
});

describe("history mode follows live attention only", () => {
  it("plays no chime, tick or pop for replayed attention and events", async () => {
    const s = await enabled();
    s.soundscape.setHistory(true);
    s.soundscape.update([needsYou("a1")]);
    s.soundscape.update([]);
    s.soundscape.update([needsYou("a2")]);
    s.soundscape.handleEvent(taskCompleted("a1"));
    s.soundscape.handleEvent(handoff("a1", "a2"));
    expect(s.cues()).toEqual([]);
  });

  it("keeps the live baseline: replay does not make a live red agent look new on return", async () => {
    const s = await enabled();
    s.soundscape.update([needsYou("a1")]);
    expect(s.cues("chime")).toHaveLength(1);

    s.soundscape.setHistory(true);
    s.soundscape.update([]); // the replayed city has nobody red
    s.soundscape.setHistory(false);
    s.soundscape.update([needsYou("a1")]); // live again, still the same red agent
    expect(s.cues("chime")).toHaveLength(1);
  });

  it("chimes for a genuinely new live needs-you start after returning to live", async () => {
    const s = await enabled();
    s.soundscape.setHistory(true);
    s.soundscape.setHistory(false);
    s.soundscape.update([needsYou("a9")]);
    expect(s.cues("chime")).toHaveLength(1);
  });
});
