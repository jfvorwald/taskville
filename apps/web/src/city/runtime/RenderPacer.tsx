import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { cameraRig } from "../interaction/index.ts";
import { movementLabels } from "../movement/index.ts";
import { presentationEpoch } from "./epoch.ts";
import { createFramePacer, createIdleThrottle, IDLE_FPS, IDLE_WAKE_MS } from "./idle-throttle.ts";
import { motionSignals } from "./motion-signals.ts";
import { watchVisibility } from "./visibility.ts";

/**
 * Drives a `frameloop="demand"` canvas: a display-paced loop that asks for a frame at 60 fps
 * while anything moves and at 20 fps once nothing has for a second (ARCHITECTURE.md section 11).
 * Idle, it sleeps on a timer between draws instead of waking every display frame; input and the
 * movement and camera stores wake it at once. Camera position, zoom and the touched flag have no
 * subscription, so the idle wake (20 a second) polls them.
 * A hidden tab stops the loop; on return it draws at once and the loop starts over (section 2.8).
 */
export function RenderPacer() {
  const invalidate = useThree((s) => s.invalidate);
  const camera = useThree((s) => s.camera);

  useEffect(() => {
    const now = () => performance.now();
    const throttle = createIdleThrottle({ now });
    let pacer = createFramePacer();
    // Pointer and key activity drives hover glow, fades and the selection marker.
    let touched = false;
    const touch = () => {
      touched = true;
    };
    const events = ["pointermove", "pointerdown", "wheel", "keydown"] as const;

    let lastView = cameraRig.getSnapshot();
    let lastZoom = camera.zoom;
    let lastX = camera.position.x;
    let lastY = camera.position.y;
    let lastZ = camera.position.z;
    let raf = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let paused = false;

    const cancelWake = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      clearTimeout(timer);
      timer = undefined;
    };
    // Run the loop on the next display frame, unless it is already due or the tab is hidden.
    const wake = () => {
      if (paused) return;
      clearTimeout(timer);
      timer = undefined;
      if (!raf) raf = requestAnimationFrame(loop);
    };

    const loop = (t: number) => {
      raf = 0;
      let idle = false;
      try {
        const view = cameraRig.getSnapshot();
        const cameraChanged =
          view !== lastView ||
          camera.zoom !== lastZoom ||
          camera.position.x !== lastX ||
          camera.position.y !== lastY ||
          camera.position.z !== lastZ;
        lastView = view;
        lastZoom = camera.zoom;
        lastX = camera.position.x;
        lastY = camera.position.y;
        lastZ = camera.position.z;
        // Working agents' loops draw at 20 fps by design (CTO decision): only walking, arriving and
        // departing count as agents moving, which keeps the idle throttle effective.
        const signals = motionSignals(movementLabels.getSnapshot(), cameraChanged, touched);
        touched = false;
        const fps = throttle.update(signals);
        idle = fps === IDLE_FPS;
        if (pacer.shouldRender(fps, t)) invalidate();
      } finally {
        if (idle) {
          timer = setTimeout(() => {
            timer = undefined;
            wake();
          }, IDLE_WAKE_MS);
        } else {
          // After invalidate(): R3F's demand loop then runs ahead of this callback on the next
          // display frame, so a requested draw lands every frame instead of every other one.
          raf = requestAnimationFrame(loop);
        }
      }
    };

    const onInput = () => {
      touch();
      wake();
    };
    for (const type of events) window.addEventListener(type, onInput, { passive: true });
    const unsubscribeLabels = movementLabels.subscribe(wake);
    const unsubscribeCamera = cameraRig.subscribe(wake);

    const stopWatching = watchVisibility(document, {
      now,
      onPause() {
        paused = true;
        cancelWake();
      },
      onResume({ hiddenForMs }) {
        paused = false;
        presentationEpoch.bump(hiddenForMs);
        pacer = createFramePacer();
        lastView = cameraRig.getSnapshot();
        raf = requestAnimationFrame(loop);
      },
    });
    if (document.visibilityState !== "hidden") raf = requestAnimationFrame(loop);

    return () => {
      stopWatching();
      paused = true;
      cancelWake();
      unsubscribeLabels();
      unsubscribeCamera();
      for (const type of events) window.removeEventListener(type, onInput);
    };
  }, [invalidate, camera]);

  return null;
}
