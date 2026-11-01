import { afterEach, describe, expect, it, vi } from "vitest";
import { type AudioBackend, createWebAudioBackend } from "../../src/audio/backend.ts";
import { type FakeAudioContext, fakeContextFactory } from "./fakeContext.ts";

// M4.09 pin round: suspend/resume timing in the real Web Audio backend, against the recording fake
// context and fake timers. The rules are stated as contract:
//   A1. A suspend asked for while a loop is fading out waits for the fade to finish.
//   A2. resume() and suspend() never overlap, and a loop starts only once the context is running
//       and idle, so a quick mute then unmute never leaves the loop silent.
//   B1. A cue still waiting on a resume is dropped if silence or disable arrives first.
//   B2. A cue that arrives while a suspend is still waiting cancels that suspend.
// The context clock is advanced together with the timers, as a running context's would be.

type SuspendableBackend = AudioBackend & { suspend(): void | Promise<void> };

afterEach(() => {
  vi.useRealTimers();
});

const asset = () => new ArrayBuffer(8);

/** Moves the fake context clock and the fake timers forward together, 10 ms at a time. */
async function elapse(ctx: FakeAudioContext, ms: number) {
  for (let spent = 0; spent < ms; spent += 10) {
    ctx.currentTime += 0.01;
    await vi.advanceTimersByTimeAsync(10);
  }
}

async function boot() {
  vi.useFakeTimers();
  const factory = fakeContextFactory();
  const backend = createWebAudioBackend({
    createContext: factory.createContext,
  }) as SuspendableBackend;
  const starting = backend.start();
  await vi.advanceTimersByTimeAsync(0);
  await starting;
  return { backend, ctx: factory.ctx };
}

/**
 * Makes resume() and suspend() take 20 ms each and records their order, whether two ever ran at
 * once, and the context state each loop source was started in.
 */
function instrument(ctx: FakeAudioContext) {
  const log: string[] = [];
  let active = 0;
  const seen = { overlapped: false };
  const op = (name: "resume" | "suspend", after: "running" | "suspended") => () => {
    if (active > 0) seen.overlapped = true;
    active += 1;
    log.push(`${name}:begin`);
    return new Promise<void>((done) => {
      setTimeout(() => {
        ctx.state = after;
        active -= 1;
        log.push(`${name}:end`);
        done();
      }, 20);
    });
  };
  const resume = op("resume", "running");
  const suspend = op("suspend", "suspended");
  ctx.resume = () => {
    ctx.resumeCalls += 1;
    return resume();
  };
  ctx.suspend = () => {
    ctx.suspendCalls += 1;
    return suspend();
  };
  const makeSource = ctx.createBufferSource.bind(ctx);
  ctx.createBufferSource = () => {
    const source = makeSource();
    const start = source.start.bind(source);
    source.start = (t: number) => {
      log.push(`loop:start(${ctx.state}${active > 0 ? ",busy" : ""})`);
      start(t);
    };
    return source;
  };
  return { log, seen };
}

describe("A1: a suspend waits for the loop fade-out to finish", () => {
  it("does not suspend until the fading loop has gone quiet, then does", async () => {
    const { backend, ctx } = await boot();
    backend.startLoop("cyberpunk", asset());
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.sources).toHaveLength(1);

    // Chime-only: the soundscape stops the loop (a 0.6 s fade) and parks the context.
    backend.stopLoop();
    void backend.suspend();
    await vi.advanceTimersByTimeAsync(0);
    expect(ctx.suspendCalls).toBe(0);

    await elapse(ctx, 500);
    expect(ctx.suspendCalls).toBe(0);
    expect(ctx.state).toBe("running");

    await elapse(ctx, 2500);
    expect(ctx.suspendCalls).toBe(1);
    expect(ctx.state).toBe("suspended");
  });
});

describe("A2: resume and suspend never overlap, and the loop starts after the resume", () => {
  it("a suspend already running finishes before the resume for an unmute starts", async () => {
    const { backend, ctx } = await boot();
    const { log, seen } = instrument(ctx);
    backend.startLoop("cyberpunk", asset());
    await vi.advanceTimersByTimeAsync(0);
    backend.stopLoop();
    await elapse(ctx, 1000); // the fade is over

    void backend.suspend(); // mute: the suspend begins at once
    await elapse(ctx, 10);
    expect(log).toContain("suspend:begin");
    expect(ctx.state).toBe("running"); // still suspending

    const unmuting = backend.start(); // unmute, mid-suspend
    backend.startLoop("cyberpunk", asset());
    await elapse(ctx, 500);
    await unmuting;

    expect(seen.overlapped).toBe(false);
    expect(ctx.state).toBe("running");
    expect(log.at(-1)).toBe("loop:start(running)");
    expect(log.lastIndexOf("resume:end")).toBeLessThan(log.length - 1);
    expect(log).toContain("resume:end");
    expect(ctx.sources).toHaveLength(2);
  });

  it("a mute then unmute inside the fade-out leaves the context running with the loop playing", async () => {
    const { backend, ctx } = await boot();
    const { log, seen } = instrument(ctx);
    backend.startLoop("cyberpunk", asset());
    await vi.advanceTimersByTimeAsync(0);

    backend.stopLoop(); // mute
    void backend.suspend();
    await elapse(ctx, 100);
    const unmuting = backend.start(); // unmute, still inside the 0.6 s fade
    backend.startLoop("cyberpunk", asset());
    await elapse(ctx, 3000);
    await unmuting;

    expect(seen.overlapped).toBe(false);
    expect(ctx.state).toBe("running"); // a late suspend must not park the context under the loop
    expect(ctx.sources).toHaveLength(2);
    expect(log.filter((entry) => entry.startsWith("loop:start"))).toEqual([
      "loop:start(running)",
      "loop:start(running)",
    ]);
  });
});

describe("B1: a cue waiting on a resume is dropped by silence or disable", () => {
  async function parked() {
    const booted = await boot();
    await booted.backend.suspend();
    expect(booted.ctx.state).toBe("suspended");
    return booted;
  }

  it("drops the cue when mute (silence) arrives before the resume settles", async () => {
    const { backend, ctx } = await parked();
    backend.playCue("chime");
    backend.silence?.();
    await elapse(ctx, 200);
    expect(ctx.oscillators).toHaveLength(0);
  });

  it("drops the cue when disable (silence then suspend) arrives before the resume settles", async () => {
    const { backend, ctx } = await parked();
    backend.playCue("chime");
    backend.silence?.();
    void backend.suspend();
    await elapse(ctx, 200);
    expect(ctx.oscillators).toHaveLength(0);
  });

  it("still sounds a cue that nothing interrupted", async () => {
    const { backend, ctx } = await parked();
    backend.playCue("chime");
    await elapse(ctx, 200);
    expect(ctx.oscillators).toHaveLength(2);
  });
});

describe("B2: a cue cancels a suspend that is still waiting", () => {
  it("does not suspend the context under a cue that arrived during the wait", async () => {
    const { backend, ctx } = await boot();
    backend.startLoop("cyberpunk", asset());
    await vi.advanceTimersByTimeAsync(0);
    backend.stopLoop();
    void backend.suspend(); // waits out the fade
    await elapse(ctx, 100);

    backend.playCue("chime");
    expect(ctx.oscillators).toHaveLength(2);
    await elapse(ctx, 3000);
    expect(ctx.suspendCalls).toBe(0);
    expect(ctx.state).toBe("running");
  });
});
