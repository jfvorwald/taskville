import styles from "./overlays.module.css";

/**
 * The DOM layer over the canvas: header, speech bubbles, panels. Later tickets add their
 * component here with a one-line edit. `pointer-events: none` on the layer lets the canvas keep
 * the pointer; an overlay that needs it turns it back on for itself.
 */
export function OverlayRoot() {
  return (
    <div className={styles.layer} data-testid="overlay-root">
      <p className={styles.badge}>Taskville · paired</p>
    </div>
  );
}
