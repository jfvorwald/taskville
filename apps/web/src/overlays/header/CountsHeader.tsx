import { useSyncExternalStore } from "react";
import type { OverlayDefinition, OverlayProps } from "../host/types.ts";
import { describeCounts, formatCounts } from "./counts.ts";
import styles from "./header.module.css";

/** The counts line at the top of the screen: `3 active · 1 needs you`. */
export function CountsHeader({ selectors }: OverlayProps) {
  const { counts } = selectors;
  const value = useSyncExternalStore(counts.subscribe, counts.getSnapshot, counts.getSnapshot);
  return (
    <p
      className={styles.counts}
      role="status"
      aria-label={describeCounts(value)}
      data-needs-you={value.needsYou > 0 ? "true" : undefined}
    >
      {formatCounts(value)}
    </p>
  );
}

export const countsHeaderOverlay: OverlayDefinition = {
  id: "counts-header",
  slot: "header",
  modes: ["live", "history"],
  Component: CountsHeader,
};
