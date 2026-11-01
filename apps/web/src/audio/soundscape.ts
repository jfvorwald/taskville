import type { Attention, StoredEnvelope } from "../data/domain.ts";
import type { AudioBackend } from "./backend.ts";
import type { Readable, SoundSettings } from "./settings.ts";

// ARCHITECTURE.md 2.7. The policy for what plays and when, with the backend and the loop loader
// injected so none of it needs a real AudioContext. Nothing here runs before enable(): browsers
// block audio until a click, and the soundscape is off by default.

/** Recorded events remembered so one delivered twice sounds once. */
const SEEN_EVENT_LIMIT = 256;

/** How long a cue takes to ring out, before a context it woke is parked again. */
const CUE_TAIL_MS = 2000;

export interface SoundscapeOptions {
  backend: AudioBackend;
  settings: Readable<SoundSettings>;
  /** Fetches the ambient loop for a theme. Called only after enable(). */
  loadLoop: (themeId: string) => Promise<unknown>;
  /** The theme in use at startup. */
  theme: string;
}

export interface Soundscape {
  readonly enabled: boolean;
  /** Call from a click. Starts the backend and the ambient loop. Safe to call again. */
  enable(): Promise<void>;
  disable(): void;
  /**
   * The current attention records. One chime per call when any agent entered needs-you, however
   * many did (calm). Agents already red when sound was enabled, or red while muted, stay silent.
   */
  update(records: readonly Attention[]): void;
  /** A recorded event: a tick on completion, a pop on handoff. Late and imported ones are silent. */
  handleEvent(event: StoredEnvelope): void;
  setTheme(themeId: string): void;
  /** In history mode attention and events are replays, so nothing sounds. */
  setHistory(history: boolean): void;
}

/** A soundscape that can also chime on demand, for a caller that decides itself who entered. */
export interface ChimingSoundscape extends Soundscape {
  /** One needs-you chime, unless sound is off, muted, or in history mode. */
  chime(): void;
}

const clamp01 = (value: number) => Math.min(1, Math.max(0, value));

export function createSoundscape(options: SoundscapeOptions): ChimingSoundscape {
  const { backend, settings, loadLoop } = options;
  let theme = options.theme;
  let enabled = false;
  let history = false;
  /** Bumped by enable() and disable(), so an enable that was undone meanwhile stops quietly. */
  let generation = 0;
  let enabling: Promise<void> | null = null;
  let unsubscribe: (() => void) | null = null;
  let volume: number | undefined;
  let wasMuted = false;
  /** Agents in needs-you at the last live update: the baseline a chime is measured against. */
  let red = new Set<string>();
  const seen = new Set<string>();
  /** The loop playing now, the one being loaded, and a counter that voids stale loads. */
  let playing: string | null = null;
  let loading: string | null = null;
  let loadToken = 0;
  /** The theme whose load just failed. Not retried until the theme changes or a loop is wanted anew. */
  let failed: string | null = null;
  /** The context is suspended: nothing could sound, so it was parked until a loop is wanted. */
  let parked = false;
  let repark: ReturnType<typeof setTimeout> | undefined;

  const silenced = () => !enabled || history || settings.getSnapshot().muted;

  function applyVolume() {
    const next = clamp01(settings.getSnapshot().volume);
    if (next === volume) return;
    volume = next;
    backend.setVolume(next);
  }

  function park() {
    if (parked) return;
    parked = true;
    backend.suspend?.();
  }

  /** A cue wakes a parked context; once it has rung out and no loop is wanted, park it again. */
  function sound(cue: "chime" | "tick" | "pop") {
    backend.playCue(cue);
    if (!parked) return;
    parked = false;
    clearTimeout(repark);
    repark = setTimeout(() => {
      const s = settings.getSnapshot();
      if (enabled && (s.muted || s.chimeOnly)) park();
    }, CUE_TAIL_MS);
  }

  function syncLoop() {
    const s = settings.getSnapshot();
    const wanted = enabled && !s.muted && !s.chimeOnly ? theme : null;
    if (wanted === null) {
      loadToken += 1;
      loading = null;
      if (playing !== null) backend.stopLoop();
      playing = null;
      failed = null;
      // Nothing can loop now, so let the context rest (disable() parks after its own silence).
      if (enabled) park();
      return;
    }
    if (wanted === playing) {
      // Back on the loop that is already playing: a load for another theme is now stale.
      loadToken += 1;
      loading = null;
      return;
    }
    if (wanted === loading || wanted === failed) return;
    loadToken += 1;
    const token = loadToken;
    loading = wanted;
    if (parked) {
      // Wake the context before the loop returns to it.
      parked = false;
      backend.start().catch(() => {});
    }
    loadLoop(wanted).then(
      (asset) => {
        if (token !== loadToken) return;
        loading = null;
        backend.startLoop(wanted, asset);
        playing = wanted;
      },
      () => {
        // No loop for this theme, or it failed to load: stay quiet rather than complain.
        if (token !== loadToken) return;
        loading = null;
        failed = wanted;
        // The old theme's loop must not play on under the new theme.
        if (playing !== null) backend.stopLoop();
        playing = null;
      },
    );
  }

  function onSettings() {
    if (!enabled) return;
    applyVolume();
    const { muted } = settings.getSnapshot();
    // Muting also cuts a cue that is still ringing.
    if (muted && !wasMuted) backend.silence?.();
    wasMuted = muted;
    syncLoop();
  }

  return {
    get enabled() {
      return enabled;
    },

    enable() {
      if (enabled) return Promise.resolve();
      if (enabling) return enabling;
      generation += 1;
      const mine = generation;
      enabling = backend
        .start()
        .then(() => {
          if (mine !== generation) return;
          enabled = true;
          volume = undefined;
          parked = false; // start() just woke the context
          failed = null;
          wasMuted = settings.getSnapshot().muted;
          applyVolume();
          unsubscribe = settings.subscribe(onSettings);
          syncLoop();
        })
        .finally(() => {
          if (mine === generation) enabling = null;
        });
      return enabling;
    },

    disable() {
      generation += 1;
      enabling = null;
      const wasEnabled = enabled;
      enabled = false;
      unsubscribe?.();
      unsubscribe = null;
      syncLoop();
      if (wasEnabled) {
        backend.silence?.();
        park();
      }
    },

    update(records) {
      if (history) return;
      const now = new Set<string>();
      for (const record of records) if (record.level === "needs_you") now.add(record.agentId);
      let entered = false;
      for (const id of now) if (!red.has(id)) entered = true;
      red = now;
      if (entered && !silenced()) sound("chime");
    },

    chime() {
      if (!silenced()) sound("chime");
    },

    handleEvent(event) {
      if (!enabled || history) return;
      if (event.provenance === "imported" || event.late === true) return;
      let cue: "tick" | "pop";
      if (event.type === "task.status_changed" && event.payload.status === "completed") {
        cue = "tick";
      } else if (event.type === "task.handoff") {
        cue = "pop";
      } else {
        return;
      }
      // Recorded before the mute check, so an event delivered while muted counts as heard.
      if (seen.has(event.eventId)) return;
      seen.add(event.eventId);
      if (seen.size > SEEN_EVENT_LIMIT) {
        const oldest = seen.values().next();
        if (!oldest.done) seen.delete(oldest.value);
      }
      const { muted, chimeOnly } = settings.getSnapshot();
      if (muted || chimeOnly) return;
      sound(cue);
    },

    setTheme(themeId) {
      if (themeId === theme) return;
      theme = themeId;
      failed = null;
      syncLoop();
    },

    setHistory(next) {
      history = next;
    },
  };
}
