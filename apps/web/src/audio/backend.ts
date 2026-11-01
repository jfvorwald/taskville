// The Web Audio side of the soundscape (ARCHITECTURE.md 2.7). Cues are synthesized live with
// oscillators, so only the ambient loops are files. Nothing here creates an AudioContext until
// start(), which the settings panel calls from a click: browsers block audio before a gesture.

export type Cue = "chime" | "tick" | "pop";

export interface AudioBackend {
  /** Creates the AudioContext (once) and resumes it. Call from a user gesture. */
  start(): Promise<void>;
  /** Master volume, 0 to 1. Cues and loops both pass through it. */
  setVolume(volume: number): void;
  playCue(cue: Cue): void;
  /** Plays the loop for `themeId` from its loaded `asset`, fading out any loop already playing. */
  startLoop(themeId: string, asset: unknown): void;
  stopLoop(): void;
  /** Cuts any cue that is still ringing (on mute or when sound is turned off). */
  silence?(): void;
  /** Parks the context so an idle city costs nothing. start() or playCue() bring it back. */
  suspend?(): void | Promise<void>;
}

export interface WebAudioBackendOptions {
  /** Defaults to the browser's AudioContext. */
  createContext?: () => AudioContext;
}

/** The ambient bed sits well under the cues. */
const LOOP_LEVEL = 0.35;
const LOOP_FADE_IN_S = 1.5;
const LOOP_FADE_OUT_S = 0.6;
/** The same cue is not repeated inside this window, so a burst of events stays gentle. */
const MIN_CUE_GAP_S = 0.15;

function browserContext(): AudioContext {
  const w = window as unknown as {
    AudioContext?: typeof AudioContext;
    webkitAudioContext?: typeof AudioContext;
  };
  const Ctor = w.AudioContext ?? w.webkitAudioContext;
  if (!Ctor) throw new Error("Web Audio is not available");
  return new Ctor();
}

interface Voice {
  source: AudioBufferSourceNode;
  gain: GainNode;
}

export function createWebAudioBackend(options: WebAudioBackendOptions = {}): AudioBackend {
  const createContext = options.createContext ?? browserContext;
  let ctx: AudioContext | null = null;
  let master: GainNode | null = null;
  /** Every cue goes through this, so silence() can cut them all at once. */
  let cueBus: GainNode | null = null;
  let volume = 0.5;
  const lastCueAt = new Map<Cue, number>();
  const decoded = new Map<string, Promise<AudioBuffer>>();
  let voice: Voice | null = null;
  let loopToken = 0;
  /**
   * resume() and suspend() run one after another, never overlapping: start() must not see a context
   * that is about to be suspended and conclude it is running.
   */
  let queue: Promise<void> = Promise.resolve();
  let inflight = 0;
  /** Bumped by every start(), cue wake-up and suspend(), so a suspend still waiting is dropped. */
  let parkToken = 0;
  /** When the loop fade-out in progress ends, on the context clock. */
  let fadingUntil = 0;

  function enqueue(step: () => Promise<void>): Promise<void> {
    // With nothing ahead of it the step starts at once: resume() must be asked for inside the
    // click that called start().
    const run = async () => step();
    const done = inflight === 0 ? run() : queue.then(run);
    inflight += 1;
    const release = () => {
      inflight -= 1;
    };
    queue = done.then(release, release);
    return done;
  }

  async function wake() {
    if (ctx?.state === "suspended") await ctx.resume();
  }

  /** One enveloped oscillator note into the master gain. */
  function note(
    context: AudioContext,
    out: AudioNode,
    opts: {
      type: OscillatorType;
      from: number;
      to?: number;
      at: number;
      duration: number;
      peak: number;
    },
  ) {
    const osc = context.createOscillator();
    const gain = context.createGain();
    osc.type = opts.type;
    osc.frequency.setValueAtTime(opts.from, opts.at);
    if (opts.to !== undefined) {
      osc.frequency.exponentialRampToValueAtTime(opts.to, opts.at + opts.duration);
    }
    gain.gain.setValueAtTime(0.0001, opts.at);
    gain.gain.exponentialRampToValueAtTime(opts.peak, opts.at + 0.01);
    gain.gain.exponentialRampToValueAtTime(0.0001, opts.at + opts.duration);
    osc.connect(gain);
    gain.connect(out);
    osc.start(opts.at);
    osc.stop(opts.at + opts.duration + 0.05);
  }

  /** The cue itself, with the rate limit measured on the running clock. */
  function sound(cue: Cue) {
    if (!ctx || !cueBus) return;
    const now = ctx.currentTime;
    const last = lastCueAt.get(cue);
    if (last !== undefined && now - last < MIN_CUE_GAP_S) return;
    lastCueAt.set(cue, now);
    const t = now + 0.01;
    switch (cue) {
      case "chime":
        note(ctx, cueBus, { type: "sine", from: 784, at: t, duration: 1.1, peak: 0.22 });
        note(ctx, cueBus, { type: "sine", from: 1047, at: t + 0.14, duration: 1.3, peak: 0.18 });
        break;
      case "tick":
        note(ctx, cueBus, { type: "triangle", from: 1800, at: t, duration: 0.05, peak: 0.1 });
        break;
      case "pop":
        note(ctx, cueBus, { type: "sine", from: 620, to: 220, at: t, duration: 0.12, peak: 0.2 });
        break;
    }
  }

  function decode(themeId: string, asset: unknown): Promise<AudioBuffer> | null {
    const cached = decoded.get(themeId);
    if (cached) return cached;
    if (!ctx || !(asset instanceof ArrayBuffer)) return null;
    // decodeAudioData detaches its input, so decode a copy and keep the original reusable.
    const pending = ctx.decodeAudioData(asset.slice(0));
    decoded.set(themeId, pending);
    pending.catch(() => decoded.delete(themeId));
    return pending;
  }

  function fadeOut(old: Voice, context: AudioContext) {
    const now = context.currentTime;
    old.gain.gain.cancelScheduledValues(now);
    old.gain.gain.setValueAtTime(old.gain.gain.value, now);
    old.gain.gain.linearRampToValueAtTime(0, now + LOOP_FADE_OUT_S);
    old.source.stop(now + LOOP_FADE_OUT_S + 0.05);
    fadingUntil = Math.max(fadingUntil, now + LOOP_FADE_OUT_S + 0.05);
  }

  return {
    async start() {
      if (!ctx) {
        ctx = createContext();
        master = ctx.createGain();
        master.gain.value = volume;
        master.connect(ctx.destination);
        cueBus = ctx.createGain();
        cueBus.connect(master);
      }
      parkToken += 1;
      await enqueue(wake);
    },

    setVolume(next) {
      volume = next;
      if (master && ctx) master.gain.setTargetAtTime(next, ctx.currentTime, 0.05);
    },

    silence() {
      if (!ctx || !master || !cueBus) return;
      // Fade the ringing bus out and swap in a fresh one for the cues that follow.
      const old = cueBus;
      old.gain.setTargetAtTime(0, ctx.currentTime, 0.015);
      setTimeout(() => old.disconnect(), 250);
      cueBus = ctx.createGain();
      cueBus.connect(master);
    },

    playCue(cue) {
      if (!ctx || !cueBus) return;
      if (inflight > 0 || ctx.state === "suspended") {
        // Parked or parking: wake the context first and sound the cue once its clock runs again.
        parkToken += 1;
        enqueue(wake).then(
          () => sound(cue),
          () => {},
        );
        return;
      }
      sound(cue);
    },

    async suspend() {
      if (!ctx) return;
      // A suspended clock is frozen, so the rate-limit times taken from it mean nothing after.
      lastCueAt.clear();
      parkToken += 1;
      const mine = parkToken;
      const context = ctx;
      // A loop still fading out would freeze mid-fade and come back on the next resume.
      const fading = fadingUntil - context.currentTime;
      if (fading > 0) await new Promise((done) => setTimeout(done, fading * 1000));
      if (mine !== parkToken) return;
      await enqueue(() => context.suspend()).catch(() => {
        // Already closed or not suspendable: nothing to park.
      });
    },

    startLoop(themeId, asset) {
      if (!ctx || !master) return;
      loopToken += 1;
      const token = loopToken;
      const buffer = decode(themeId, asset);
      if (!buffer) return;
      // Start only once the context has finished resuming or suspending.
      Promise.all([buffer, queue]).then(
        ([decodedBuffer]) => {
          if (token !== loopToken || !ctx || !master) return;
          const now = ctx.currentTime;
          if (voice) fadeOut(voice, ctx);
          const source = ctx.createBufferSource();
          const gain = ctx.createGain();
          source.buffer = decodedBuffer;
          source.loop = true;
          gain.gain.setValueAtTime(0, now);
          gain.gain.linearRampToValueAtTime(LOOP_LEVEL, now + LOOP_FADE_IN_S);
          source.connect(gain);
          gain.connect(master);
          source.start(now);
          voice = { source, gain };
        },
        () => {
          // A loop that cannot be decoded leaves the city quiet; the cues still work. The old
          // theme's loop must not play on under the new theme.
          if (token !== loopToken) return;
          if (voice && ctx) fadeOut(voice, ctx);
          voice = null;
        },
      );
    },

    stopLoop() {
      loopToken += 1;
      if (voice && ctx) fadeOut(voice, ctx);
      voice = null;
    },
  };
}
