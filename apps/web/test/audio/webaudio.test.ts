import { afterEach, describe, expect, it, vi } from "vitest";
import { type AudioBackend, createWebAudioBackend } from "../../src/audio/backend.ts";
import { type FakeGain, fakeContextFactory } from "./fakeContext.ts";
import { settle } from "./fakes.ts";

// The real Web Audio backend, run against a recording fake AudioContext (see fakeContext.ts). No
// audio hardware: these pin what the backend asks the context to do. M4.09 review fix round.

/** The idle-cost hook the review asked for; typed here until AudioBackend declares it. */
type SuspendableBackend = AudioBackend & { suspend(): void | Promise<void> };

async function started() {
  const factory = fakeContextFactory();
  const backend = createWebAudioBackend({
    createContext: factory.createContext,
  }) as SuspendableBackend;
  await backend.start();
  return { backend, ctx: factory.ctx, factory };
}

const asset = (bytes = 8) => new ArrayBuffer(bytes);

/** The gain a loop source feeds: its voice. */
const voiceOf = (source: { outputs: unknown[] } | undefined) => source?.outputs[0] as FakeGain;

afterEach(() => {
  vi.useRealTimers();
});

describe("start()", () => {
  it("creates the context once and resumes it while suspended", async () => {
    const { backend, ctx, factory } = await started();
    expect(factory.made).toHaveLength(1);
    expect(ctx.resumeCalls).toBe(1);
    expect(ctx.state).toBe("running");

    await backend.start();
    expect(factory.made).toHaveLength(1);
    // Already running: nothing left to resume.
    expect(ctx.resumeCalls).toBe(1);
  });

  it("resumes again when the context was suspended in the meantime", async () => {
    const { backend, ctx } = await started();
    await backend.suspend();
    expect(ctx.state).toBe("suspended");
    await backend.start();
    expect(ctx.resumeCalls).toBe(2);
    expect(ctx.state).toBe("running");
  });
});

describe("startLoop()", () => {
  it("plays a looping source and fades it in", async () => {
    const { backend, ctx } = await started();
    backend.startLoop("cyberpunk", asset());
    await settle();

    expect(ctx.sources).toHaveLength(1);
    const [source] = ctx.sources;
    expect(source?.loop).toBe(true);
    expect(source?.startedAt).toBe(0);
    const ramp = voiceOf(source).gain.calls.find((c) => c.method === "linearRampToValueAtTime");
    expect(ramp?.args[0]).toBeGreaterThan(0);
    expect(ramp?.args[1]).toBeGreaterThan(0);
  });

  it("crossfades: the old voice fades out and stops, the new one fades in", async () => {
    const { backend, ctx } = await started();
    backend.startLoop("cyberpunk", asset());
    await settle();
    ctx.currentTime = 10;
    backend.startLoop("steampunk", asset());
    await settle();

    expect(ctx.sources).toHaveLength(2);
    const [oldSource, newSource] = ctx.sources;
    expect(voiceOf(oldSource).gain.aimedAtZero()).toBe(true);
    expect(oldSource?.stops).toHaveLength(1);
    expect(oldSource?.stops[0]).toBeGreaterThan(10);
    expect(newSource?.startedAt).toBe(10);
    expect(newSource?.stops).toEqual([]);
  });

  it("never starts a load that a newer startLoop superseded, whatever order they settle in", async () => {
    for (const order of ["oldest first", "newest first"] as const) {
      const { backend, ctx } = await started();
      ctx.decodeMode = "manual";
      backend.startLoop("cyberpunk", asset(10));
      backend.startLoop("steampunk", asset(20));
      expect(ctx.decodes).toHaveLength(2);
      const [first, second] = ctx.decodes;
      if (order === "oldest first") {
        first?.resolve();
        second?.resolve();
      } else {
        second?.resolve();
        first?.resolve();
      }
      await settle();

      expect(ctx.sources, order).toHaveLength(1);
      expect(ctx.sources[0]?.buffer, order).toBe(second?.buffer);
    }
  });

  it("never starts a load that stopLoop() overtook", async () => {
    const { backend, ctx } = await started();
    ctx.decodeMode = "manual";
    backend.startLoop("cyberpunk", asset());
    backend.stopLoop();
    ctx.decodes[0]?.resolve();
    await settle();
    expect(ctx.sources).toEqual([]);
  });

  it("decodes each theme's asset once and reuses the buffer", async () => {
    const { backend, ctx } = await started();
    backend.startLoop("cyberpunk", asset());
    await settle();
    backend.startLoop("steampunk", asset());
    await settle();
    expect(ctx.decodes).toHaveLength(2);

    backend.startLoop("cyberpunk", asset());
    await settle();
    // Back on a theme already decoded: no second decode, and the same buffer plays.
    expect(ctx.decodes).toHaveLength(2);
    expect(ctx.sources).toHaveLength(3);
    expect(ctx.sources[2]?.buffer).toBe(ctx.sources[0]?.buffer);
  });

  it("decodes a copy, so the loaded asset stays usable", async () => {
    const { backend, ctx } = await started();
    const original = asset(16);
    backend.startLoop("cyberpunk", original);
    await settle();
    expect(original.byteLength).toBe(16);
    expect(ctx.decodes[0]?.bytes).toBe(16);
  });
});

describe("a loop that cannot be decoded", () => {
  it("fades the old voice out and forgets it", async () => {
    const { backend, ctx } = await started();
    backend.startLoop("cyberpunk", asset());
    await settle();
    const oldSource = ctx.sources[0];

    ctx.currentTime = 10;
    ctx.decodeMode = "reject";
    backend.startLoop("steampunk", asset());
    await settle();

    // The old theme's loop must not play on under the new theme.
    expect(voiceOf(oldSource).gain.aimedAtZero()).toBe(true);
    expect(oldSource?.stops).toHaveLength(1);
    expect(ctx.sources).toHaveLength(1);

    // The voice is cleared: neither stopLoop() nor the next loop fades it a second time.
    backend.stopLoop();
    ctx.decodeMode = "auto";
    backend.startLoop("solarpunk", asset());
    await settle();
    expect(oldSource?.stops).toHaveLength(1);
    expect(ctx.sources).toHaveLength(2);
  });

  it("leaves the current loop alone when a superseded load fails late", async () => {
    const { backend, ctx } = await started();
    backend.startLoop("cyberpunk", asset());
    await settle();

    ctx.decodeMode = "manual";
    backend.startLoop("steampunk", asset());
    backend.startLoop("solarpunk", asset());
    const [, stale, current] = ctx.decodes;
    current?.resolve();
    await settle();
    stale?.reject();
    await settle();

    // solarpunk is playing; steampunk's late failure must not stop it.
    expect(ctx.sources).toHaveLength(2);
    expect(ctx.sources[1]?.stops).toEqual([]);
  });
});

describe("silence()", () => {
  it("cuts a cue that is still ringing and routes later cues to a fresh bus", async () => {
    const { backend, ctx } = await started();
    backend.playCue("chime");
    const [ringingBus] = ctx.feedingMaster();
    expect(ringingBus?.gain.aimedAtZero()).toBe(false);

    vi.useFakeTimers();
    backend.silence?.();
    expect(ringingBus?.gain.aimedAtZero()).toBe(true);
    // The cut bus is dropped once its tail is gone.
    vi.advanceTimersByTime(1000);
    expect(ringingBus?.disconnected).toBe(true);

    ctx.currentTime = 5;
    backend.playCue("chime");
    const buses = ctx.feedingMaster();
    expect(buses).toHaveLength(2);
    const freshBus = buses[1];
    expect(freshBus?.gain.aimedAtZero()).toBe(false);
    expect(ctx.gains.at(-1)?.outputs).toContain(freshBus);
  });

  it("leaves the ambient loop playing", async () => {
    const { backend, ctx } = await started();
    backend.startLoop("cyberpunk", asset());
    await settle();
    vi.useFakeTimers();
    backend.silence?.();
    expect(voiceOf(ctx.sources[0]).gain.aimedAtZero()).toBe(false);
    expect(ctx.sources[0]?.stops).toEqual([]);
  });
});

describe("playCue() rate limit", () => {
  it("drops a repeat of the same cue inside 0.15 s and allows it after", async () => {
    const { backend, ctx } = await started();
    ctx.currentTime = 1;
    backend.playCue("tick");
    backend.playCue("tick");
    expect(ctx.oscillators).toHaveLength(1);

    ctx.currentTime = 1.1;
    backend.playCue("tick");
    expect(ctx.oscillators).toHaveLength(1);

    ctx.currentTime = 1.16;
    backend.playCue("tick");
    expect(ctx.oscillators).toHaveLength(2);
  });

  it("limits each cue kind on its own", async () => {
    const { backend, ctx } = await started();
    ctx.currentTime = 1;
    backend.playCue("chime"); // two notes
    backend.playCue("tick");
    backend.playCue("pop");
    expect(ctx.oscillators).toHaveLength(4);
    backend.playCue("chime");
    backend.playCue("tick");
    backend.playCue("pop");
    expect(ctx.oscillators).toHaveLength(4);
  });
});

describe("suspend() (idle cost)", () => {
  it("suspends the context", async () => {
    const { backend, ctx } = await started();
    await backend.suspend();
    expect(ctx.suspendCalls).toBe(1);
    expect(ctx.state).toBe("suspended");
  });

  it("is a harmless no-op before start(), and builds no context", () => {
    const factory = fakeContextFactory();
    const backend = createWebAudioBackend({
      createContext: factory.createContext,
    }) as SuspendableBackend;
    expect(() => backend.suspend()).not.toThrow();
    expect(factory.made).toHaveLength(0);
  });

  it("brings a suspended context back for a cue and still sounds it", async () => {
    const { backend, ctx } = await started();
    ctx.resumeAdvance = 1;
    ctx.currentTime = 5;
    backend.playCue("tick");
    expect(ctx.oscillators).toHaveLength(1);

    await backend.suspend();
    // A suspended clock is frozen at 5, inside the cue's rate-limit window; the cue must still
    // get through once the context runs again.
    backend.playCue("tick");
    await settle();
    expect(ctx.resumeCalls).toBe(2);
    expect(ctx.state).toBe("running");
    expect(ctx.oscillators).toHaveLength(2);
  });
});
