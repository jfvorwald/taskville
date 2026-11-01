import { afterEach, describe, expect, it, vi } from "vitest";
import { createSoundscape } from "../../src/audio/soundscape.ts";
import { fakeBackend, fakeLoader, fakeSettings } from "./fakes.ts";

// M4.09 pin round: when the soundscape parks the audio context. The contract, in one line:
// the context is never suspended while any cue is still sounding.
//   B3. After a cue wakes a parked context and no loop is wanted, the context is parked again only
//       once the cue has rung out (a short delay), and not at all if a loop is wanted by then.
//   C1. In chime-only mode a later chime pushes the park deadline out to cover itself.
//   C2. A volume change while a chime rings does not park the context early.
//   C3. Switching to chime-only while a chime rings does not park the context early.
//   G.  Mute and disable still park at once: they cut the ringing cue, so nothing is left to finish.
// A chime rings for about 1.5 s (two notes, the second ending 1.5 s after the cue starts), so
// "while the chime rings" is the first 1400 ms after it, and "eventually" is within 5 s.

const RINGING_MS = 1400;
const EVENTUALLY_MS = 5000;

afterEach(() => {
  vi.useRealTimers();
});

async function scene(initial: Parameters<typeof fakeSettings>[0] = {}) {
  vi.useFakeTimers();
  const fake = fakeBackend();
  const settings = fakeSettings(initial);
  const loader = fakeLoader();
  const soundscape = createSoundscape({
    backend: fake.backend,
    settings,
    loadLoop: loader.instant,
    theme: "cyberpunk",
  });
  await soundscape.enable();
  await vi.advanceTimersByTimeAsync(0);
  return { ...fake, settings, soundscape };
}

const advance = (ms: number) => vi.advanceTimersByTimeAsync(ms);

describe("B3: re-parking after a cue woke the context", () => {
  it("parks again only after the cue has rung out", async () => {
    const s = await scene({ chimeOnly: true });
    expect(s.suspends()).toHaveLength(1); // parked on enable: nothing to loop
    s.soundscape.chime();
    expect(s.cues("chime")).toHaveLength(1);

    await advance(RINGING_MS);
    expect(s.suspends()).toHaveLength(1);
    await advance(EVENTUALLY_MS - RINGING_MS);
    expect(s.suspends()).toHaveLength(2);
  });

  it("does not park again when a loop is wanted again by then", async () => {
    const s = await scene({ chimeOnly: true });
    s.soundscape.chime();
    await advance(500);
    s.settings.patch({ chimeOnly: false });
    await advance(EVENTUALLY_MS);
    expect(s.playingLoop()).toBe("cyberpunk");
    expect(s.suspends()).toHaveLength(1);
  });
});

describe("C1: the park deadline covers the latest cue", () => {
  it("does not cut off a second chime that follows the first by 1.8 s", async () => {
    const s = await scene({ chimeOnly: true });
    s.soundscape.chime();
    await advance(1800);
    s.soundscape.chime();
    expect(s.cues("chime")).toHaveLength(2);

    await advance(RINGING_MS); // the second chime is still ringing
    expect(s.suspends()).toHaveLength(1);
    await advance(EVENTUALLY_MS);
    expect(s.suspends()).toHaveLength(2);
  });
});

describe("C2: a volume change while a chime rings", () => {
  it("does not suspend the context before the chime finishes", async () => {
    const s = await scene({ chimeOnly: true });
    s.soundscape.chime();
    await advance(500);
    s.settings.patch({ volume: 0.9 });
    expect(s.lastVolume()).toBe(0.9);
    expect(s.suspends()).toHaveLength(1);

    await advance(RINGING_MS - 500);
    expect(s.suspends()).toHaveLength(1);
    await advance(EVENTUALLY_MS);
    expect(s.suspends()).toHaveLength(2);
  });
});

describe("C3: switching to chime-only while a chime rings", () => {
  it("does not suspend the context before the chime finishes, but does after", async () => {
    const s = await scene();
    expect(s.playingLoop()).toBe("cyberpunk");
    expect(s.suspends()).toHaveLength(0);
    s.soundscape.chime();
    await advance(500);
    s.settings.patch({ chimeOnly: true });
    expect(s.playingLoop()).toBeNull();
    expect(s.suspends()).toHaveLength(0);

    await advance(RINGING_MS - 500);
    expect(s.suspends()).toHaveLength(0);
    await advance(EVENTUALLY_MS);
    expect(s.suspends()).toHaveLength(1);
  });
});

describe("G: mute and disable park at once, because they cut the cue", () => {
  it("parks on mute while a chime rings, and only once", async () => {
    const s = await scene({ chimeOnly: true });
    s.soundscape.chime();
    await advance(500);
    s.settings.patch({ muted: true });
    expect(s.silences()).toHaveLength(1);
    expect(s.suspends()).toHaveLength(2);
    await advance(EVENTUALLY_MS);
    expect(s.suspends()).toHaveLength(2);
  });

  it("parks on disable while a chime rings, and only once", async () => {
    const s = await scene({ chimeOnly: true });
    s.soundscape.chime();
    await advance(500);
    s.soundscape.disable();
    expect(s.suspends()).toHaveLength(2);
    await advance(EVENTUALLY_MS);
    expect(s.suspends()).toHaveLength(2);
  });
});
