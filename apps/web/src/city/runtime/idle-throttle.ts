/** ARCHITECTURE.md section 11: full rate while anything moves, 20 fps once nothing has. */
export const FULL_FPS = 60;
export const IDLE_FPS = 20;

const DEFAULT_IDLE_AFTER_MS = 1000;
const DISPLAY_FRAME_MS = 1000 / 60;
/** How early a display tick may land on a frame deadline: timer noise, not a free frame. */
const PACER_TOLERANCE_MS = 2;

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

export interface FramePacer {
  /** Called once per display tick; true when this tick should be drawn. */
  shouldRender(targetFps: number, now: number): boolean;
}

/**
 * Paces draws to `targetFps` on any display refresh rate. It carries a frame deadline from draw
 * to draw rather than comparing against the last draw time, so a 90 Hz display averages 60 fps
 * instead of drawing every tick, and a little timer noise does not skip a frame. A higher target
 * takes effect at once, and a long pause (a hidden tab) restarts the deadline instead of
 * catching up in a burst.
 */
export function createFramePacer(): FramePacer {
  let deadline: number | null = null;
  let lastDrawAt = 0;
  let lastInterval = 0;
  return {
    shouldRender(targetFps, now) {
      const interval = 1000 / targetFps;
      if (deadline !== null && interval < lastInterval) {
        deadline = Math.min(deadline, lastDrawAt + interval);
      }
      lastInterval = interval;
      if (deadline !== null && now < deadline - PACER_TOLERANCE_MS) return false;
      deadline = (deadline ?? now) + interval;
      if (deadline <= now) deadline = now + interval;
      lastDrawAt = now;
      return true;
    },
  };
}
