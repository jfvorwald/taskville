import type { MovementLabel } from "../movement/labels.ts";
import type { MotionSignals } from "./idle-throttle.ts";

/** Turns the agent labels, a camera change and pointer or key activity into the throttle's signals. */
export function motionSignals(
  labels: readonly MovementLabel[],
  cameraChanged: boolean,
  touched: boolean,
): MotionSignals {
  return {
    agentsMoving: labels.some(
      (l) => l.state === "walking" || l.state === "arriving" || l.state === "departing",
    ),
    cameraMoving: cameraChanged,
    effectsActive: touched,
  };
}
