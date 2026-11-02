import { describe, expect, it } from "vitest";
import { createStore } from "zustand/vanilla";
import { connectSoundscape, type SoundscapeSources } from "../../src/audio/connect.ts";
import { createSoundscape } from "../../src/audio/soundscape.ts";
import type { StoredEnvelope } from "../../src/data/domain.ts";
import type { AttentionFeed } from "../../src/overlays/header/attention.ts";
import { createAttentionStore } from "../../src/overlays/header/attentionSync.ts";
import { handoff, taskCompleted } from "../city/effects/events.ts";
import { fakeBackend, fakeLoader, fakeSettings, needsYou, settle, trouble } from "./fakes.ts";

// M4.09 (roborev 5949): the needs-you chime comes from the GLOBAL attention feed (ARCHITECTURE
// 2.8, built in M4.01), not from the selected project's data store. An agent entering needs-you in
// ANY project chimes once; switching the shown project never chimes for agents already waiting.
// The completion tick and handoff pop stay with the current project's live events.
//
// The sources are the app's real attention store (the feed and its `ready` flag), a fake event
// source standing in for the data store's `onEvent`, and a theme store. The soundscape is real,
// on a recording backend, so these pin behaviour and not the soundscape's internal call shape.

const project = (projectId: string, ...records: ReturnType<typeof needsYou>[]) => ({
  projectId,
  name: projectId.toUpperCase(),
  attention: records,
});
const feedOf = (...projects: ReturnType<typeof project>[]): AttentionFeed =>
  Object.fromEntries(projects.map((p) => [p.projectId, p]));

function rig() {
  const fake = fakeBackend();
  const soundscape = createSoundscape({
    backend: fake.backend,
    settings: fakeSettings(),
    loadLoop: fakeLoader().instant,
    theme: "cyberpunk",
  });
  const attention = createAttentionStore();
  const listeners = new Set<(event: StoredEnvelope) => void>();
  const theme = createStore<{ themeId: string; history: boolean }>()(() => ({
    themeId: "cyberpunk",
    history: false,
  }));
  const sources: SoundscapeSources = {
    attention,
    data: {
      onEvent(listener) {
        listeners.add(listener);
        return () => {
          listeners.delete(listener);
        };
      },
    },
    theme,
  };
  const emit = (event: StoredEnvelope) => {
    for (const listener of [...listeners]) listener(event);
  };
  /** Feed state as a snapshot from the engine delivers it: the feed, and ready. */
  const snapshot = (feed: AttentionFeed) => attention.setState({ feed, ready: true });
  return { ...fake, soundscape, attention, theme, sources, emit, snapshot, listeners };
}

/** Connected, the first snapshot in (so the feed is trusted), and sound enabled. */
async function live(initial: AttentionFeed = feedOf()) {
  const r = rig();
  const off = connectSoundscape(r.soundscape, r.sources);
  r.snapshot(initial);
  await r.soundscape.enable();
  await settle();
  return { ...r, off };
}

describe("the chime follows the global attention feed", () => {
  it("chimes once when an agent enters needs-you in any project", async () => {
    const r = await live(feedOf(project("alpha"), project("beta")));
    expect(r.cues("chime")).toHaveLength(0);

    r.snapshot(feedOf(project("alpha"), project("beta", needsYou("b1"))));

    expect(r.cues("chime")).toHaveLength(1);
  });

  it("plays one combined chime when agents in several projects enter in one update", async () => {
    const r = await live();

    r.snapshot(
      feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"), needsYou("b2"))),
    );

    expect(r.cues("chime")).toHaveLength(1);
  });

  it("chimes for a newcomer in another project while an old agent stays red", async () => {
    const r = await live(feedOf(project("alpha", needsYou("a1"))));
    expect(r.cues("chime")).toHaveLength(0);

    r.snapshot(feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"))));
    expect(r.cues("chime")).toHaveLength(1);

    // The old agent alone, again, in a new feed object: nobody new.
    r.snapshot(feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"))));
    expect(r.cues("chime")).toHaveLength(1);
  });

  it("chimes again when an agent leaves needs-you and re-enters, or drops to trouble and returns", async () => {
    const r = await live();
    r.snapshot(feedOf(project("beta", needsYou("b1"))));
    r.snapshot(feedOf());
    r.snapshot(feedOf(project("beta", needsYou("b1"))));
    expect(r.cues("chime")).toHaveLength(2);

    r.snapshot(feedOf(project("beta", trouble("b1"))));
    r.snapshot(feedOf(project("beta", needsYou("b1"))));
    expect(r.cues("chime")).toHaveLength(3);
  });

  it("does not chime for agents already red when sound is enabled", async () => {
    const r = rig();
    connectSoundscape(r.soundscape, r.sources);
    r.snapshot(feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"))));

    await r.soundscape.enable();
    await settle();
    r.snapshot(feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"))));

    expect(r.cues("chime")).toHaveLength(0);
  });

  it("does not chime for the first snapshot, when sound was enabled before the feed was ready", async () => {
    const r = rig();
    connectSoundscape(r.soundscape, r.sources);
    await r.soundscape.enable();
    await settle();
    expect(r.attention.getState().ready).toBe(false);

    // Records arrive with the first snapshot: they were already waiting.
    r.snapshot(feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"))));
    expect(r.cues("chime")).toHaveLength(0);

    // Then someone really new.
    r.snapshot(
      feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"), needsYou("b2"))),
    );
    expect(r.cues("chime")).toHaveLength(1);
  });

  it("does not chime for feed content that arrives while the feed is not ready", async () => {
    const r = rig();
    connectSoundscape(r.soundscape, r.sources);
    await r.soundscape.enable();
    await settle();

    r.attention.setState({ feed: feedOf(project("beta", needsYou("b1"))) });
    expect(r.cues("chime")).toHaveLength(0);
    r.attention.setState({ ready: true });
    expect(r.cues("chime")).toHaveLength(0);
  });

  it("does not chime when the feed is replaced by the same agents, as a reconnect snapshot does", async () => {
    const r = await live(feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"))));

    r.snapshot(
      feedOf(project("beta", needsYou("b1", "fresh-request")), project("alpha", needsYou("a1"))),
    );

    expect(r.cues("chime")).toHaveLength(0);
  });

  it("tells the same agent ID in two projects apart", async () => {
    const r = await live(feedOf(project("alpha", needsYou("worker"))));

    r.snapshot(feedOf(project("alpha", needsYou("worker")), project("beta", needsYou("worker"))));

    expect(r.cues("chime")).toHaveLength(1);
  });

  it.each([":", "|", "/", ",", "-", "_", ".", "#", " ", "\u0000", "\t"])(
    "keys agents by (project, agent), never a string joined with %j",
    async (sep) => {
      // Joined with `sep`, ("a" + sep + "b", "c") and ("a", "b" + sep + "c") are the same string.
      const r = await live(feedOf(project(`a${sep}b`, needsYou("c"))));

      r.snapshot(feedOf(project(`a${sep}b`, needsYou("c")), project("a", needsYou(`b${sep}c`))));

      expect(r.cues("chime")).toHaveLength(1);
    },
  );

  it("is silent before sound is enabled, however much the feed changes", async () => {
    const r = rig();
    connectSoundscape(r.soundscape, r.sources);
    r.snapshot(feedOf(project("beta", needsYou("b1"))));
    r.snapshot(feedOf());
    r.snapshot(feedOf(project("alpha", needsYou("a1"))));
    await settle();
    expect(r.calls).toEqual([]);
  });

  it("stops following the feed once disposed", async () => {
    const r = await live();
    r.off();

    r.snapshot(feedOf(project("beta", needsYou("b1"))));

    expect(r.cues("chime")).toHaveLength(0);
  });

  it("keeps replay silent in history while chiming once for a new global live entry", async () => {
    const r = await live(feedOf(project("alpha", needsYou("a1"))));
    r.theme.setState({ history: true });

    // Recorded city attention and events are replay, never global live alerts (ARCHITECTURE 3).
    r.soundscape.update([needsYou("recorded-agent")]);
    r.emit(taskCompleted("recorded-agent"));
    r.emit(handoff("recorded-agent", "recorded-recipient"));
    expect(r.cues()).toHaveLength(0);

    // The existing global connection still observes a new agent in another project.
    r.snapshot(feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"))));
    expect(r.cues("chime")).toHaveLength(1);

    r.snapshot(feedOf(project("alpha", needsYou("a1")), project("beta", needsYou("b1"))));
    expect(r.cues("chime")).toHaveLength(1);
    expect(r.cues("tick")).toHaveLength(0);
    expect(r.cues("pop")).toHaveLength(0);
  });
});

describe("the tick and the pop stay with the current project's live events", () => {
  it("ticks on a completion and pops on a handoff from the event source", async () => {
    const r = await live();

    r.emit(taskCompleted("a1"));
    r.emit(handoff("a1", "a2"));

    expect(r.cues("tick")).toHaveLength(1);
    expect(r.cues("pop")).toHaveLength(1);
    expect(r.cues("chime")).toHaveLength(0);
  });

  it("does not turn an event into a chime, and a chime does not wait for an event", async () => {
    const r = await live();

    r.snapshot(feedOf(project("beta", needsYou("b1"))));
    expect(r.cues("chime")).toHaveLength(1);
    expect(r.cues("tick")).toHaveLength(0);
    expect(r.cues("pop")).toHaveLength(0);
  });

  it("stops listening for events once disposed", async () => {
    const r = await live();
    expect(r.listeners.size).toBe(1);

    r.off();

    expect(r.listeners.size).toBe(0);
    r.emit(taskCompleted("a1"));
    expect(r.cues("tick")).toHaveLength(0);
  });
});

describe("the theme", () => {
  it("is passed on at connect and when it changes", async () => {
    const r = rig();
    r.theme.setState({ themeId: "steampunk" });
    connectSoundscape(r.soundscape, r.sources);
    await r.soundscape.enable();
    await settle();
    expect(r.playingLoop()).toBe("steampunk");

    r.theme.setState({ themeId: "aero" });
    await settle();
    expect(r.playingLoop()).toBe("aero");
  });
});
