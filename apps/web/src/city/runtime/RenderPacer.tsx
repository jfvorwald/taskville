import { useThree } from "@react-three/fiber";
import { useEffect } from "react";
import { cameraRig } from "../interaction/index.ts";
import { movementLabels } from "../movement/index.ts";
import { presentationEpoch } from "./epoch.ts";
import { createFramePacer, createIdleThrottle } from "./idle-throttle.ts";
import { motionSignals } from "./motion-signals.ts";
import { watchVisibility } from "./visibility.ts";

/**
 * Drives a `frameloop="demand"` canvas: one display-paced loop that asks for a frame at 60 fps
 * while anything moves and at 20 fps once nothing has for a second (ARCHITECTURE.md section 11).
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
    for (const type of events) window.addEventListener(type, touch, { passive: true });

    let lastView = cameraRig.getSnapshot();
    let lastZoom = camera.zoom;
    let lastX = camera.position.x;
    let lastY = camera.position.y;
    let lastZ = camera.position.z;
    let raf = 0;

    const loop = (t: number) => {
      raf = requestAnimationFrame(loop);
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
      if (!pacer.shouldRender(throttle.update(signals), t)) return;
      invalidate();
    };

    const stopWatching = watchVisibility(document, {
      now,
      onPause() {
        cancelAnimationFrame(raf);
      },
      onResume({ hiddenForMs }) {
        presentationEpoch.bump(hiddenForMs);
        pacer = createFramePacer();
        lastView = cameraRig.getSnapshot();
        raf = requestAnimationFrame(loop);
      },
    });
    if (document.visibilityState !== "hidden") raf = requestAnimationFrame(loop);

    return () => {
      stopWatching();
      cancelAnimationFrame(raf);
      for (const type of events) window.removeEventListener(type, touch);
    };
  }, [invalidate, camera]);

  return null;
}
