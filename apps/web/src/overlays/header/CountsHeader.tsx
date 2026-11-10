import { useSyncExternalStore } from "react";
import { DEFAULT_PROJECT_ID, selectProject, useCurrentProjectId } from "../../data/project.ts";
import { useRelease } from "../../release/identity.ts";
import { ReleaseBadge, ReleaseBanner } from "../../release/ReleaseBadge.tsx";
import { InteractiveRegion } from "../host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayProps } from "../host/types.ts";
import { ProjectPicker } from "../project-picker/ProjectPicker.tsx";
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
  const release = useRelease();
  return (
    <div className={styles.row}>
      <ReleaseBanner release={release} />
      <p
        className={styles.counts}
        role="status"
        aria-label={describeCounts(shown)}
        data-needs-you={needsYou > 0 ? "true" : undefined}
      >
        {formatCounts(shown)}
      </p>
      <ProjectPicker />
      {otherProjects.length > 0 || away ? (
        <InteractiveRegion
          className={styles.chips}
          {...(mode === "history" ? { role: "group", "aria-label": "Live" } : {})}
        >
          <AttentionChips otherProjects={otherProjects} onSwitch={selectProject} />
          {away ? (
            // Kept alongside the picker: one click home, and the only way back when unpaired.
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
      <ReleaseBadge release={release} />
    </div>
  );
}

export const countsHeaderOverlay: OverlayDefinition = {
  id: "counts-header",
  slot: "header",
  modes: ["live", "history"],
  Component: CountsHeader,
};
