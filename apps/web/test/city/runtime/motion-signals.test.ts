import { describe, expect, it } from "vitest";
import type { MovementLabel } from "../../../src/city/movement/labels.ts";
import type { PresentationState } from "../../../src/city/movement/navigator.ts";
import { motionSignals } from "../../../src/city/runtime/motion-signals.ts";

// M3.14 code-review fix (S3). The glue that turns the agent labels, camera change and pointer or
// key activity into the idle throttle's three signals is a pure function, so it is tested
// without a canvas.

const label = (id: string, state: PresentationState): MovementLabel => ({
  id,
  name: id,
  status: "x",
  onTheWay: false,
  state,
  urgent: false,
});

describe("motionSignals", () => {
  it("is all false for no agents, a still camera and no activity", () => {
    expect(motionSignals([], false, false)).toEqual({
      agentsMoving: false,
      cameraMoving: false,
      effectsActive: false,
    });
  });

  it.each(["walking", "arriving", "departing"] as const)(
    "a %s label means agents are moving",
    (state) => {
      expect(motionSignals([label("a", "working"), label("b", state)], false, false)).toEqual({
        agentsMoving: true,
        cameraMoving: false,
        effectsActive: false,
      });
    },
  );

  it.each(["working", "idle", "waiting", "stuck"] as const)(
    "a %s label alone does not mean agents are moving",
    (state) => {
      expect(motionSignals([label("a", state)], false, false).agentsMoving).toBe(false);
    },
  );

  it("cameraChanged sets cameraMoving only", () => {
    expect(motionSignals([label("a", "idle")], true, false)).toEqual({
      agentsMoving: false,
      cameraMoving: true,
      effectsActive: false,
    });
  });

  it("touched sets effectsActive only", () => {
    expect(motionSignals([label("a", "idle")], false, true)).toEqual({
      agentsMoving: false,
      cameraMoving: false,
      effectsActive: true,
    });
  });
});
