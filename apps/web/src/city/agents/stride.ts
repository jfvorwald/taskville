/** Walk-cycle speed in radians per second: the former 0.25 per frame at 60 Hz. */
const STRIDE_RATE = 15;

/** Advances the walk cycle by elapsed time, so the pace does not depend on the display's frame rate. */
export function advanceStride(stride: number, deltaSeconds: number): number {
  return stride + STRIDE_RATE * deltaSeconds;
}
