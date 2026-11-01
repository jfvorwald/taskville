import { afterEach, describe, expect, it, vi } from "vitest";
import { createSoundscape } from "../../src/audio/soundscape.ts";
import { fakeBackend, fakeLoader, fakeSettings } from "./fakes.ts";

// M4.13: a failed ambient load leaves no loop to keep the context awake. Use the same
// ring-out bounds as soundscape-timing.test.ts: still ringing at 1.4 s, finished within 5 s.
const RINGING_MS = 1400;
const EVENTUALLY_MS = 5000;
const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

afterEach(() => {
  vi.useRealTimers();
});

async function scene() {
  vi.useFakeTimers();
  const fake = fakeBackend();
  const loader = fakeLoader();
  const settings = fakeSettings();
  const soundscape = createSoundscape({
    backend: fake.backend,
    settings,
    loadLoop: loader.loadLoop,
    theme: "cyberpunk",
  });
  await soundscape.enable();
  expect(loader.requested).toEqual(["cyberpunk"]);
  return { ...fake, loader, settings, soundscape };
}

describe("M4.13: parking after an ambient load rejects", () => {
  it("parks without a cue, stays enabled, and does not retry on volume changes", async () => {
    const s = await scene();
    expect(s.suspends()).toHaveLength(0); // pending loads still need an awake context
    s.loader.reject("cyberpunk");
    await advance(0);
    expect(s.playingLoop()).toBeNull();
    expect(s.soundscape.enabled).toBe(true);
    expect.soft(s.suspends()).toHaveLength(1);

    s.settings.patch({ volume: 0.8 });
    await advance(EVENTUALLY_MS);
    expect(s.lastVolume()).toBe(0.8);
    expect(s.loader.requested).toEqual(["cyberpunk"]);
    expect(s.suspends()).toHaveLength(1);
  });

  it("defers parking for a cue already ringing when the load rejects", async () => {
    const s = await scene();
    s.soundscape.chime();
    await advance(500);
    s.loader.reject("cyberpunk");
    await advance(0);
    expect(s.cues("chime")).toHaveLength(1);
    expect(s.silences()).toHaveLength(0);
    expect(s.suspends()).toHaveLength(0);

    await advance(RINGING_MS - 500);
    expect(s.suspends()).toHaveLength(0);
    await advance(EVENTUALLY_MS - RINGING_MS);
    expect(s.suspends()).toHaveLength(1);
  });

  it("lets a later cue wake the failed-loop context and parks after its tail", async () => {
    const s = await scene();
    s.loader.reject("cyberpunk");
    await advance(0);
    expect.soft(s.suspends()).toHaveLength(1);
    s.soundscape.chime(); // backend.playCue wakes a parked context
    expect(s.cues("chime")).toHaveLength(1);
    await advance(RINGING_MS);
    expect.soft(s.suspends()).toHaveLength(1);
    await advance(EVENTUALLY_MS - RINGING_MS);
    expect(s.suspends()).toHaveLength(2);
    expect(s.loader.requested).toEqual(["cyberpunk"]);
  });

  it.each(["theme change", "mute/unmute"])("wakes and retries after %s", async (retry) => {
    const s = await scene();
    s.loader.reject("cyberpunk");
    await advance(0);
    expect.soft(s.suspends()).toHaveLength(1);
    const mark = s.calls.length;
    const nextTheme = retry === "theme change" ? "steampunk" : "cyberpunk";
    if (retry === "theme change") {
      s.soundscape.setTheme(nextTheme);
    } else {
      s.settings.patch({ muted: true });
      s.settings.patch({ muted: false });
    }
    expect(s.loader.requested).toEqual(["cyberpunk", nextTheme]);
    expect.soft(s.calls.slice(mark).filter((call) => call.op === "start")).toHaveLength(1);
    expect.soft(s.lastIndex("start")).toBeGreaterThan(s.lastIndex("suspend"));
    const parksDuringRetry = s.suspends().length;
    await advance(EVENTUALLY_MS);
    expect(s.suspends()).toHaveLength(parksDuringRetry);

    s.loader.resolve(nextTheme);
    await advance(0);
    expect(s.loops()).toEqual([
      { op: "startLoop", themeId: nextTheme, asset: `asset:${nextTheme}` },
    ]);
    expect(s.lastIndex("startLoop")).toBeGreaterThan(s.lastIndex("start"));
    await advance(EVENTUALLY_MS);
    expect(s.suspends()).toHaveLength(parksDuringRetry);
  });

  it.each(["loading", "playing"])(
    "does not park at the cue tail when a retry is %s",
    async (state) => {
      const s = await scene();
      s.soundscape.chime();
      s.loader.reject("cyberpunk");
      await advance(0);
      await advance(500);
      s.soundscape.setTheme("steampunk");
      if (state === "playing") {
        s.loader.resolve("steampunk");
        await advance(0);
        expect(s.playingLoop()).toBe("steampunk");
      }
      await advance(EVENTUALLY_MS);
      expect(s.suspends()).toHaveLength(0);
      expect(s.loader.requested).toEqual(["cyberpunk", "steampunk"]);
    },
  );
});
