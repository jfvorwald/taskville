import { useSyncExternalStore } from "react";
import { selectProject, useCurrentProjectId } from "../../data/project.ts";
import { InteractiveRegion } from "../host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayProps } from "../host/types.ts";
import { selectAttentionHeader } from "./attention.ts";
import { AttentionChips } from "./attentionChips.tsx";
import { useAttentionFeed } from "./attentionSync.ts";
import { describeCounts, formatCounts } from "./counts.ts";
import styles from "./header.module.css";

/**
 * The counts line at the top of the screen, `3 active · 1 needs you`, and one chip for each other
 * project that has an agent waiting on you (`Beta: 2 need you`); a chip opens that project.
 */
export function CountsHeader({ selectors }: OverlayProps) {
  const { counts } = selectors;
  const value = useSyncExternalStore(counts.subscribe, counts.getSnapshot, counts.getSnapshot);
  const feed = useAttentionFeed();
  const currentProjectId = useCurrentProjectId();
  const { otherProjects } = selectAttentionHeader(feed, currentProjectId);
  return (
    <div className={styles.row}>
      <p
        className={styles.counts}
        role="status"
        aria-label={describeCounts(value)}
        data-needs-you={value.needsYou > 0 ? "true" : undefined}
      >
        {formatCounts(value)}
      </p>
      {otherProjects.length > 0 ? (
        <InteractiveRegion className={styles.chips}>
          <AttentionChips otherProjects={otherProjects} onSwitch={selectProject} />
        </InteractiveRegion>
      ) : null}
    </div>
  );
}

export const countsHeaderOverlay: OverlayDefinition = {
  id: "counts-header",
  slot: "header",
  modes: ["live", "history"],
  Component: CountsHeader,
};
