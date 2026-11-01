/** ARCHITECTURE.md section 11: full rate while anything moves, 20 fps once nothing has. */
export const FULL_FPS = 60;
export const IDLE_FPS = 20;

const DEFAULT_IDLE_AFTER_MS = 1000;
const DISPLAY_FRAME_MS = 1000 / 60;

/** What keeps the picture changing. Any one of them holds the full rate. */
export interface MotionSignals {
  readonly agentsMoving: boolean;
  readonly cameraMoving: boolean;
  readonly effectsActive: boolean;
}

export interface IdleThrottleOptions {
  now(): number;
  /** How long nothing must have moved before the rate drops. */
  idleAfterMs?: number;
}

export interface IdleThrottle {
  /** Feed the current signals; returns the frame rate to draw at. */
  update(signals: MotionSignals): number;
}

export function createIdleThrottle({
  now,
  idleAfterMs = DEFAULT_IDLE_AFTER_MS,
}: IdleThrottleOptions): IdleThrottle {
  let stillSince = now();
  let moving = false;
  return {
    update({ agentsMoving, cameraMoving, effectsActive }) {
      const t = now();
      const wasMoving = moving;
      moving = agentsMoving || cameraMoving || effectsActive;
      if (moving) return FULL_FPS;
      // The delay counts from the first update that sees everything still.
      if (wasMoving) stillSince = t;
      return t - stillSince >= idleAfterMs ? IDLE_FPS : FULL_FPS;
    },
  };
}

/**
 * Whether a display frame arriving at `now` should be drawn at `targetFps`. A frame may come up
 * to 0.4 of a display frame early, so a 60 Hz display still gets every third frame at 20 fps and
 * a faster display is not starved at 60 fps.
 */
export function shouldRenderFrame(
  targetFps: number,
  lastRenderAt: number | null,
  now: number,
): boolean {
  if (lastRenderAt === null) return true;
  return now - lastRenderAt >= 1000 / targetFps - DISPLAY_FRAME_MS * 0.4;
}
