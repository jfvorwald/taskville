import { Canvas, useFrame } from "@react-three/fiber";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
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
  movementLabels.set([]);
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
    await sleep(IDLE_SETTLE_MS + 500);
    expect(await rendersOverWindow()).toBeLessThanOrEqual(IDLE_MAX_RENDERS);
  });
});
