import type { AudioBackend, Cue } from "../../src/audio/backend.ts";
import type { SoundSettings } from "../../src/audio/settings.ts";
import type { Attention } from "../../src/data/domain.ts";
import type { Selector } from "../../src/overlays/host/types.ts";

// Test doubles for the soundscape. No real AudioContext anywhere: the backend records what it was
// asked to do, and the ambient loader hands back a token instead of decoded audio.

export type BackendCall =
  | { op: "start" }
  | { op: "setVolume"; volume: number }
  | { op: "playCue"; cue: Cue }
  | { op: "startLoop"; themeId: string; asset: unknown }
  | { op: "stopLoop" }
  | { op: "silence" }
  | { op: "suspend" };

export function fakeBackend() {
  const calls: BackendCall[] = [];
  // suspend() is the idle-cost hook (M4.09 review): the soundscape parks the context when nothing
  // can sound, and start() or playCue brings it back.
  const backend: AudioBackend & { suspend(): void } = {
    async start() {
      calls.push({ op: "start" });
    },
    setVolume(volume) {
      calls.push({ op: "setVolume", volume });
    },
    playCue(cue) {
      calls.push({ op: "playCue", cue });
    },
    startLoop(themeId, asset) {
      calls.push({ op: "startLoop", themeId, asset });
    },
    stopLoop() {
      calls.push({ op: "stopLoop" });
    },
    silence() {
      calls.push({ op: "silence" });
    },
    suspend() {
      calls.push({ op: "suspend" });
    },
  };
  const cues = (cue?: Cue) =>
    calls.filter((c) => c.op === "playCue" && (cue === undefined || c.cue === cue));
  /** How many times the backend was told to cut a ringing cue. */
  const silences = () => calls.filter((c) => c.op === "silence");
  const suspends = () => calls.filter((c) => c.op === "suspend");
  /** Index of the last call with this op, or -1. */
  const lastIndex = (op: BackendCall["op"]) => calls.map((c) => c.op).lastIndexOf(op);
  const loops = () =>
    calls.filter((c): c is Extract<BackendCall, { op: "startLoop" }> => c.op === "startLoop");
  /** The loop playing now: the last startLoop with no stopLoop after it. */
  const playingLoop = () => {
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      const call = calls[i];
      if (call?.op === "stopLoop") return null;
      if (call?.op === "startLoop") return call.themeId;
    }
    return null;
  };
  const lastVolume = () => {
    for (let i = calls.length - 1; i >= 0; i -= 1) {
      const call = calls[i];
      if (call?.op === "setVolume") return call.volume;
    }
    return undefined;
  };
  return { backend, calls, cues, silences, suspends, lastIndex, loops, playingLoop, lastVolume };
}

export function fakeSettings(initial: Partial<SoundSettings> = {}) {
  let snapshot: SoundSettings = { volume: 0.5, muted: false, chimeOnly: false, ...initial };
  const listeners = new Set<() => void>();
  const store: Selector<SoundSettings> & { patch(next: Partial<SoundSettings>): void } = {
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    getSnapshot: () => snapshot,
    patch(next) {
      snapshot = { ...snapshot, ...next };
      for (const listener of [...listeners]) listener();
    },
  };
  return store;
}

/** A loader that records requests and lets the test decide when each one resolves. */
export function fakeLoader() {
  const requested: string[] = [];
  const pending = new Map<string, Array<(asset: unknown) => void>>();
  const failures = new Map<string, Array<(error: unknown) => void>>();
  const loadLoop = (themeId: string) => {
    requested.push(themeId);
    return new Promise<unknown>((resolve, reject) => {
      pending.set(themeId, [...(pending.get(themeId) ?? []), resolve]);
      failures.set(themeId, [...(failures.get(themeId) ?? []), reject]);
    });
  };
  /** Fail every pending request for a theme, as a network or decode error would. */
  const reject = (themeId: string) => {
    for (const r of failures.get(themeId) ?? []) r(new Error(`load failed: ${themeId}`));
    failures.delete(themeId);
    pending.delete(themeId);
  };
  /** Resolve every pending request for a theme with the token `asset:<theme>`. */
  const resolve = (themeId: string) => {
    for (const r of pending.get(themeId) ?? []) r(`asset:${themeId}`);
    pending.delete(themeId);
    failures.delete(themeId);
  };
  /** Resolves the moment it is called. */
  const instant = (themeId: string) => {
    requested.push(themeId);
    return Promise.resolve(`asset:${themeId}`);
  };
  return { loadLoop, requested, resolve, reject, instant };
}

let requestSeq = 0;
export function needsYou(agentId: string, requestId?: string): Attention {
  requestSeq += 1;
  return {
    agentId,
    level: "needs_you",
    kind: "permission",
    since: "2026-11-01T10:00:00.000Z",
    requestId: requestId ?? `req-${requestSeq}`,
    heuristic: false,
  };
}

/** Telemetry-only needs-you: no bridge request behind it (ARCHITECTURE 2.2). */
export function needsYouFromTelemetry(agentId: string): Attention {
  return {
    agentId,
    level: "needs_you",
    kind: "input",
    since: "2026-11-01T10:00:00.000Z",
    heuristic: false,
  };
}

export function trouble(agentId: string): Attention {
  return {
    agentId,
    level: "trouble",
    kind: "tool_failures",
    since: "2026-11-01T10:00:00.000Z",
    heuristic: false,
  };
}

export function waiting(agentId: string): Attention {
  return {
    agentId,
    level: "waiting",
    kind: "turn_ended",
    since: "2026-11-01T10:00:00.000Z",
    heuristic: false,
  };
}

/** Let promise chains and microtasks settle (loader resolution, backend start). */
export const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
