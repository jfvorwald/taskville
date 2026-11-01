import { useSyncExternalStore } from "react";
import { DEFAULT_PROJECT_ID, selectProject, useCurrentProjectId } from "../../data/project.ts";
import { InteractiveRegion } from "../host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayProps } from "../host/types.ts";
import { selectAttentionHeader } from "./attention.ts";
import { AttentionChips } from "./attentionChips.tsx";
import { useAttentionFeed, useAttentionReady } from "./attentionSync.ts";
import { describeCounts, formatCounts } from "./counts.ts";
import styles from "./header.module.css";

/**
 * The counts line at the top of the screen, `3 active · 1 needs you`, and one chip for each other
 * project that has an agent waiting on you (`Beta: 2 need you`); a chip opens that project.
 */
export function CountsHeader({ selectors, mode }: OverlayProps) {
  const { counts } = selectors;
  const value = useSyncExternalStore(counts.subscribe, counts.getSnapshot, counts.getSnapshot);
  const feed = useAttentionFeed();
  const currentProjectId = useCurrentProjectId();
  const ready = useAttentionReady();
  const { needsYouTotal, otherProjects } = selectAttentionHeader(feed, currentProjectId);
  // Live needs-you totals span every project once the feed is ready. History keeps its
  // recorded count; the live feed continues separately for navigation and live alerts.
  const needsYou = mode === "live" && ready ? needsYouTotal : value.needsYou;
  const shown = { ...value, needsYou };
  const away = currentProjectId !== DEFAULT_PROJECT_ID;
  return (
    <div className={styles.row}>
      <p
        className={styles.counts}
        role="status"
        aria-label={describeCounts(shown)}
        data-needs-you={needsYou > 0 ? "true" : undefined}
      >
        {formatCounts(shown)}
      </p>
      {otherProjects.length > 0 || away ? (
        <InteractiveRegion className={styles.chips}>
          <AttentionChips otherProjects={otherProjects} onSwitch={selectProject} />
          {away ? (
            // Until a project switcher exists, a chip is the only way in, so there must be a way back.
            <button
              type="button"
              className={styles.chip}
              onClick={() => selectProject(DEFAULT_PROJECT_ID)}
            >
              Back to Unsorted
            </button>
          ) : null}
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
