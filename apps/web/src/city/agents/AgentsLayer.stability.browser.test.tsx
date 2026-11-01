import { Canvas, type RootState } from "@react-three/fiber";
import { useState } from "react";
import type { Sprite } from "three";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { AgentsLayer } from "./AgentsLayer.tsx";
import type { ActivityView, AgentLabelEntry, AgentView } from "./types.ts";

// A store update hands the layer a new `AgentView` object for every agent, usually with the same
// text. None of that may redraw label textures or re-notify the world-labels slot.

function agents(activity: ActivityView = "implementing"): AgentView[] {
  // A fresh array of fresh objects on every call, like a selector re-running after an event.
  return [
    {
      id: "a1",
      kind: "session",
      displayName: "Ada",
      activity,
      placement: { x: -1, y: 0, z: 0, heading: 0 },
    },
    {
      id: "a2",
      kind: "session",
      displayName: "Grace",
      activity: "idle",
      placement: { x: 1, y: 0, z: 0, heading: 0 },
    },
  ];
}

interface StageProps {
  list: AgentView[];
  onLabels?: ((entries: readonly AgentLabelEntry[]) => void) | undefined;
  onState: (state: RootState) => void;
}

function Stage({ list, onLabels, onState }: StageProps) {
  return (
    <div style={{ width: 200, height: 150 }}>
      <Canvas camera={{ position: [0, 1.5, 4], fov: 40 }} onCreated={onState}>
        <AgentsLayer
          agents={list}
          reducedMotion
          {...(onLabels === undefined ? {} : { onLabels })}
        />
      </Canvas>
    </div>
  );
}

// The full browser suite runs files in parallel on software WebGL (SwiftShader), and a page can
// then go several seconds without a frame or a commit (4.6 s measured), so these waits need far
// more than `vi.waitFor`'s 1 s default. A healthy run still meets each condition in milliseconds.
const FRAME_WAIT = { timeout: 10_000 };

/**
 * Waits until `frames` more frames are drawn: the settle window after a rerender, before checking
 * that nothing was redrawn or re-sent. Counted in frames, not time, and bounded generously.
 */
async function framesLater(state: RootState, frames: number): Promise<void> {
  const target = state.gl.info.render.frame + frames;
  await vi.waitFor(
    () => expect(state.gl.info.render.frame).toBeGreaterThanOrEqual(target),
    FRAME_WAIT,
  );
}

/**
 * The parent keeps state and re-renders on every notification, as a slot owner would, so the
 * inline `onLabels` is a new function each time. The guard only stops a runaway loop from
 * hanging the browser; a correct layer never reaches it.
 */
function Parent({
  list,
  received,
  onState,
}: {
  list: AgentView[];
  received: Array<readonly AgentLabelEntry[]>;
  onState: (state: RootState) => void;
}) {
  const [, setTick] = useState(0);
  return (
    <Stage
      list={list}
      onState={onState}
      onLabels={(entries) => {
        received.push(entries);
        if (received.length < 20) setTick((t) => t + 1);
      }}
    />
  );
}

describe("label texture redraws", () => {
  it("redraws only when the text changes, not when the agent object is replaced", async () => {
    let state: RootState | undefined;
    const onState = (s: RootState) => {
      state = s;
    };
    const screen = await render(<Stage list={agents()} onState={onState} />);
    await vi.waitFor(() => expect(state).toBeDefined(), FRAME_WAIT);
    const root = state as RootState;
    const versions = (): number[] => {
      const out: number[] = [];
      root.scene.traverse((o) => {
        if (o.type === "Sprite") out.push((o as Sprite).material.map?.version ?? 0);
      });
      return out;
    };
    await vi.waitFor(() => {
      expect(versions()).toHaveLength(2);
      expect(versions().every((v) => v >= 1)).toBe(true);
    }, FRAME_WAIT);
    await framesLater(root, 3);
    const before = versions();

    // New array, new objects, identical name and status.
    await screen.rerender(<Stage list={agents()} onState={onState} />);
    await framesLater(root, 5);
    await screen.rerender(<Stage list={agents()} onState={onState} />);
    await framesLater(root, 5);
    expect(versions()).toEqual(before);

    // A status change redraws that agent's label, and only that one.
    await screen.rerender(<Stage list={agents("testing")} onState={onState} />);
    await vi.waitFor(() => {
      const now = versions();
      expect(now[0]).toBeGreaterThan(before[0] ?? 0);
    }, FRAME_WAIT);
    expect(versions()[1]).toBe(before[1]);
  }, 60_000);
});

describe("onLabels notifications", () => {
  it("is not re-sent or cleared when the agent array is replaced with the same text", async () => {
    let state: RootState | undefined;
    const onState = (s: RootState) => {
      state = s;
    };
    const onLabels = vi.fn<(entries: readonly AgentLabelEntry[]) => void>();
    const screen = await render(<Stage list={agents()} onLabels={onLabels} onState={onState} />);
    await vi.waitFor(() => expect(onLabels).toHaveBeenCalled(), FRAME_WAIT);
    const root = state as RootState;
    expect(onLabels.mock.calls[0]?.[0].map((e) => `${e.name}/${e.status}`)).toEqual([
      "Ada/Implementing",
      "Grace/Idle",
    ]);
    const callsAfterMount = onLabels.mock.calls.length;

    await screen.rerender(<Stage list={agents()} onLabels={onLabels} onState={onState} />);
    await framesLater(root, 5);
    await screen.rerender(<Stage list={agents()} onLabels={onLabels} onState={onState} />);
    await framesLater(root, 5);
    expect(onLabels.mock.calls.length).toBe(callsAfterMount);
    expect(onLabels.mock.calls.some(([entries]) => entries.length === 0)).toBe(false);

    // Changed text is a real update: sent once, with no empty list in between.
    await screen.rerender(<Stage list={agents("testing")} onLabels={onLabels} onState={onState} />);
    await vi.waitFor(
      () => expect(onLabels.mock.calls.length).toBe(callsAfterMount + 1),
      FRAME_WAIT,
    );
    expect(onLabels.mock.calls.at(-1)?.[0][0]?.status).toBe("Testing");
    expect(onLabels.mock.calls.some(([entries]) => entries.length === 0)).toBe(false);

    // Unmounting is the one time the slot is told to clear.
    await screen.unmount();
    await vi.waitFor(() => expect(onLabels.mock.calls.at(-1)?.[0]).toEqual([]), FRAME_WAIT);
  }, 60_000);

  it("hands the current entries to an onLabels that arrives after mount", async () => {
    let state: RootState | undefined;
    const onState = (s: RootState) => {
      state = s;
    };
    const list = agents();
    // Mounted without a callback: local labels draw, nobody to tell.
    const screen = await render(<Stage list={list} onState={onState} />);
    await vi.waitFor(() => expect(state).toBeDefined(), FRAME_WAIT);
    const root = state as RootState;
    await framesLater(root, 3);

    // The slot attaches later with the agents unchanged: local labels hide, so it must hear them.
    const onLabels = vi.fn<(entries: readonly AgentLabelEntry[]) => void>();
    await screen.rerender(<Stage list={list} onLabels={onLabels} onState={onState} />);
    await vi.waitFor(() => expect(onLabels).toHaveBeenCalled(), FRAME_WAIT);
    await framesLater(root, 5);
    expect(onLabels).toHaveBeenCalledTimes(1);
    expect(onLabels.mock.calls[0]?.[0].map((e) => `${e.name}/${e.status}`)).toEqual([
      "Ada/Implementing",
      "Grace/Idle",
    ]);

    // Same agents again (new objects, same text) and an inline replacement callback: no repeat.
    const second = vi.fn<(entries: readonly AgentLabelEntry[]) => void>();
    await screen.rerender(<Stage list={agents()} onLabels={second} onState={onState} />);
    await framesLater(root, 5);
    expect(onLabels).toHaveBeenCalledTimes(1);
    expect(second).not.toHaveBeenCalled();

    await screen.unmount();
    await vi.waitFor(() => expect(second.mock.calls.at(-1)?.[0]).toEqual([]), FRAME_WAIT);
  }, 60_000);

  it("does not call back repeatedly when the callback is a new inline function each render", async () => {
    let state: RootState | undefined;
    const received: Array<readonly AgentLabelEntry[]> = [];
    const list = agents();
    const screen = await render(
      <Parent
        list={list}
        received={received}
        onState={(s) => {
          state = s;
        }}
      />,
    );
    await vi.waitFor(() => expect(received.length).toBeGreaterThan(0), FRAME_WAIT);
    await framesLater(state as RootState, 10);
    expect(received.filter((entries) => entries.length > 0)).toHaveLength(1);
    expect(received.some((entries) => entries.length === 0)).toBe(false);
    await screen.unmount();
  }, 60_000);
});
