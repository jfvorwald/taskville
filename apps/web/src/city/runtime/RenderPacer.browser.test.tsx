import { Canvas, useFrame } from "@react-three/fiber";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { cameraRig } from "../interaction/index.ts";
import { movementLabels } from "../movement/index.ts";
import { RenderPacer } from "./RenderPacer.tsx";

// W1.02 (#546, profile in docs/tasks/W1.01.md): the pacer asked for its next animation frame
// before calling invalidate(), so R3F's demand loop started one display frame late and stopped,
// and only every other display frame drew (33 fps moving on a 60 Hz display). A unit test of the
// pacer's decisions cannot see that. This one counts real R3F renders per animation frame.
//
// Renders are counted by a probe `useFrame`, which runs once per R3F render pass (the same pass
// that draws). A window is 60 requestAnimationFrame callbacks of the test's own.

const WINDOW_FRAMES = 60;
const MOVING_MIN_RENDERS = 54;
const IDLE_MAX_RENDERS = 22;
const IDLE_SETTLE_MS = 1500;

const WALKING = [
  {
    id: "a1",
    name: "Ada",
    status: "Walking",
    onTheWay: true,
    state: "walking" as const,
    urgent: false,
  },
];

let renders = 0;

function Probe() {
  useFrame(() => {
    renders += 1;
  });
  return null;
}

const nextFrame = () => new Promise<number>((resolve) => requestAnimationFrame(resolve));
const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** Renders drawn while `WINDOW_FRAMES` animation frames go by. */
async function rendersOverWindow(): Promise<number> {
  await nextFrame();
  const before = renders;
  for (let i = 0; i < WINDOW_FRAMES; i++) await nextFrame();
  return renders - before;
}

/**
 * Mount the city and wait until the pacer has settled into idle. The settle time counts from the
 * pacer's first render, not from `render()`: under load (CI runs ~80 WebGL browser files at once)
 * R3F mounts the canvas children, and so starts the pacer, up to 1.5 s after `render()` returns,
 * and the pacer by design runs at full rate for its first second.
 */
async function settleFromFirstRender() {
  const deadline = Date.now() + 15000;
  while (renders === 0 && Date.now() < deadline) await sleep(20); // setTimeout, not rAF
  await sleep(IDLE_SETTLE_MS + 500);
}

async function mountCity() {
  renders = 0;
  await render(
    <div style={{ width: 200, height: 200 }}>
      <Canvas frameloop="demand">
        <Probe />
        <RenderPacer />
      </Canvas>
    </div>,
  );
}

afterEach(() => {
  vi.restoreAllMocks();
  movementLabels.set([]);
  cameraRig.reset();
});

describe("RenderPacer frame rate", () => {
  it("renders on at least 54 of 60 animation frames while an agent is walking", async () => {
    movementLabels.set(WALKING);
    await mountCity();
    await sleep(300); // let the first frames and the loop settle
    expect(await rendersOverWindow()).toBeGreaterThanOrEqual(MOVING_MIN_RENDERS);
  });

  it("renders on at most 22 of 60 animation frames after 1.5 s with nothing moving", async () => {
    movementLabels.set([]);
    await mountCity();
    await settleFromFirstRender();
    expect(await rendersOverWindow()).toBeLessThanOrEqual(IDLE_MAX_RENDERS);
  });
});

// W1.04 (#548): while nothing moves the pacer still woke up on every display frame (about 60
// callbacks a second) to decide not to draw. Idle should wake about as often as it draws (20 fps).
//
// Callbacks are counted by spying on `window.requestAnimationFrame` and wrapping each callback, so
// the count is callbacks that actually ran. Only the pacer's own are counted: R3F schedules a frame
// of its own for every draw it is asked for (about 20 a second idle, measured), which no pacer
// can avoid, so the spy keeps callbacks requested directly from RenderPacer.tsx or
// idle-throttle.ts (the Owns files; R3F's are requested from inside invalidate()). Today that is about 60 a second. The window is timed with
// setTimeout, never a test rAF, so the test adds no callbacks of its own.

const IDLE_CALLBACKS_PER_SECOND_MAX = 22;
const COUNT_WINDOW_MS = 1000;

/** Animation-frame callbacks that ran during `ms` of wall time. */
async function callbacksOver(ms: number): Promise<number> {
  const original = window.requestAnimationFrame.bind(window);
  let ran = 0;
  vi.spyOn(window, "requestAnimationFrame").mockImplementation((cb) => {
    // The first stack frame that is neither this spy nor the spy library is whoever asked.
    const caller =
      (new Error().stack ?? "")
        .split("\n")
        .slice(1)
        .find((line) => !/RenderPacer\.browser\.test|plugins\./.test(line)) ?? "";
    const fromPacer = /RenderPacer\.tsx|idle-throttle\.ts/.test(caller);
    return original((t) => {
      if (fromPacer) ran += 1;
      cb(t);
    });
  });
  // A callback already scheduled before the spy runs uncounted and schedules the next one through
  // the spy, so the chain is counted from its second callback on.
  await sleep(ms);
  vi.restoreAllMocks();
  return ran;
}

describe("RenderPacer idle wakeups", () => {
  it("runs at most 22 animation-frame callbacks per second after 1.5 s with nothing moving", async () => {
    movementLabels.set([]);
    await mountCity();
    await settleFromFirstRender();
    const ran = await callbacksOver(COUNT_WINDOW_MS);
    expect(ran).toBeLessThanOrEqual(IDLE_CALLBACKS_PER_SECOND_MAX);
  });
});

// Idle must still draw at its 20 fps (ARCHITECTURE section 11). Sleeping on a timer between idle
// checks must not skip frames: a headed run measured 18.9 fps because the timer starts after the
// callback, the next animation frame lands on the following vsync, and a wake judged not yet due
// sleeps another full period. The window is timed with setTimeout so the test adds no rAF callbacks.

// A fixed renders-per-second floor is wrong on a loaded machine: the browser delivers animation
// frames irregularly there (gaps of 67 to 850 ms measured in CI). So the bound is relative to the
// frames actually delivered during the window, counted by this test's own rAF chain (allowed in
// this test only; the callback test above stays rAF-free). At a steady 60 Hz the pacer draws every
// third frame; after a stall it draws on the first frame, so renders per delivered frame only
// rises. The skip-a-frame bug (timer started from the callback) drew 56 renders in 180 delivered
// frames; this bound is floor(180 / 3) - 2 = 58, so it still fails that.

const IDLE_RATE_WINDOW_MS = 3000;
const IDLE_FRAME_SLACK = 2;

describe("RenderPacer idle frame rate", () => {
  it("draws on about every third delivered animation frame after 1.5 s with nothing moving", async () => {
    movementLabels.set([]);
    await mountCity();
    await settleFromFirstRender();
    let delivered = 0;
    let counting = true;
    const tick = () => {
      if (!counting) return;
      delivered += 1;
      requestAnimationFrame(tick);
    };
    const before = renders;
    requestAnimationFrame(tick);
    await sleep(IDLE_RATE_WINDOW_MS);
    counting = false;
    const drawn = renders - before;
    expect(drawn).toBeGreaterThanOrEqual(Math.floor(delivered / 3) - IDLE_FRAME_SLACK);
  });
});

// Responsiveness while idle: whatever the pacer does to stop polling, a change must still draw
// within 2 animation frames. Each trial lands the change at a different phase of the 20 fps idle
// cycle, because a pacer that sleeps between draws is latest for a change just after one.

const RESPONSE_FRAMES_MAX = 2;
const TRIAL_OFFSETS_MS = [0, 11, 23, 37, 52];

/** Animation frames that pass after `change()` before a render happens (0 when none within 10). */
async function framesUntilRender(change: () => void): Promise<number> {
  await nextFrame();
  const before = renders;
  change();
  for (let frames = 1; frames <= 10; frames++) {
    await nextFrame();
    if (renders > before) return frames;
  }
  return Number.POSITIVE_INFINITY;
}

async function settleIdle() {
  movementLabels.set([]);
  await mountCity();
  await settleFromFirstRender();
}

describe("RenderPacer responsiveness while idle", () => {
  it("renders within 2 animation frames of a pointermove", async () => {
    await settleIdle();
    for (const offset of TRIAL_OFFSETS_MS) {
      await sleep(IDLE_SETTLE_MS + offset);
      const frames = await framesUntilRender(() =>
        window.dispatchEvent(new PointerEvent("pointermove", { clientX: 10, clientY: 10 })),
      );
      expect(frames, `offset ${offset} ms`).toBeLessThanOrEqual(RESPONSE_FRAMES_MAX);
    }
  });

  it("renders within 2 animation frames of an agent starting to walk", async () => {
    await settleIdle();
    for (const offset of TRIAL_OFFSETS_MS) {
      movementLabels.set([]);
      await sleep(IDLE_SETTLE_MS + offset);
      const frames = await framesUntilRender(() => movementLabels.set(WALKING));
      expect(frames, `offset ${offset} ms`).toBeLessThanOrEqual(RESPONSE_FRAMES_MAX);
    }
  });

  it("renders within 2 animation frames of a cameraRig change", async () => {
    await settleIdle();
    for (const offset of TRIAL_OFFSETS_MS) {
      await sleep(IDLE_SETTLE_MS + offset);
      const frames = await framesUntilRender(() => cameraRig.orbitBy(15));
      expect(frames, `offset ${offset} ms`).toBeLessThanOrEqual(RESPONSE_FRAMES_MAX);
    }
  });
});
