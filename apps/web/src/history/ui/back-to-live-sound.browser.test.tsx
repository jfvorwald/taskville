import { afterEach, describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import {
  fakeBackend,
  fakeLoader,
  fakeSettings,
  needsYou,
  settle,
} from "../../../test/audio/fakes.ts";
import { connectSoundscape } from "../../audio/connect.ts";
import { createSoundscape } from "../../audio/soundscape.ts";
import { createDataStore } from "../../data/store.ts";
import { type AttentionFrame, applyAttentionFrame } from "../../overlays/header/attention.ts";
import { createAttentionStore } from "../../overlays/header/attentionSync.ts";

// This pins the existing public global connection, not a second widget soundscape or a guessed
// injection prop. The same real soundscape must distinguish live attention from replay effects.
const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});
function rig() {
  const backend = fakeBackend();
  const settings = fakeSettings({ chimeOnly: true });
  const soundscape = createSoundscape({
    backend: backend.backend,
    settings,
    loadLoop: fakeLoader().instant,
    theme: "cyberpunk",
  });
  const attention = createAttentionStore();
  const theme = createStore(() => ({ themeId: "cyberpunk", history: true }));
  const off = connectSoundscape(soundscape, { attention, theme, data: createDataStore() });
  cleanups.push(() => {
    off();
    soundscape.disable();
  });
  const frame = (frame: AttentionFrame) =>
    attention.setState({
      feed: applyAttentionFrame(attention.getState().feed, frame),
      ...(frame.event === "snapshot" ? { ready: true } : {}),
    });
  const snapshot = (...agents: string[]) =>
    frame({
      event: "snapshot",
      data: {
        projects: [
          {
            projectId: "another-project",
            name: "Other city",
            attention: agents.map((agent) => needsYou(agent, `request-${agent}`)),
          },
        ],
      },
    });
  return { ...backend, settings, soundscape, attention, snapshot, off };
}

describe("live attention chime while browsing history", () => {
  it("chimes once for a new global needs-you entry with sound on, without replaying the baseline", async () => {
    const r = rig();
    await r.soundscape.enable();
    await settle();
    r.snapshot("already-waiting");
    expect(r.cues("chime")).toHaveLength(0);
    r.snapshot("already-waiting", "new-a", "new-b");
    expect(r.cues("chime")).toHaveLength(1); // Intended RED: history currently suppresses even LIVE feed chimes.
    r.snapshot("already-waiting", "new-a", "new-b");
    expect(r.cues("chime")).toHaveLength(1);
    r.attention.setState({ ready: false, feed: {} });
    r.snapshot("reconnected");
    expect(r.cues("chime")).toHaveLength(1);
    r.snapshot("reconnected", "next");
    expect(r.cues("chime")).toHaveLength(2);
    r.off();
    r.snapshot("after-dispose");
    expect(r.cues("chime")).toHaveLength(2);
  });

  it("keeps global history alerts silent while sound is off", async () => {
    const r = rig();
    r.snapshot();
    r.snapshot("new-a");
    r.snapshot("new-a", "new-b");
    await settle();
    expect(r.calls).toEqual([]);
  });

  it("honors mute in history and does not replay muted entries on unmute", async () => {
    const r = rig();
    await r.soundscape.enable();
    await settle();
    r.snapshot();
    r.settings.patch({ muted: true });
    r.snapshot("muted-entry");
    expect(r.cues("chime")).toHaveLength(0);
    r.settings.patch({ muted: false });
    r.snapshot("muted-entry");
    expect(r.cues("chime")).toHaveLength(0);
    r.snapshot("muted-entry", "audible-entry");
    expect(r.cues("chime")).toHaveLength(1);
  });
});
