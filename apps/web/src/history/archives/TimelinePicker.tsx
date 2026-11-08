import { useHistoryPresentation } from "../ui/HistoryProvider.tsx";
import { choiceText } from "./archive-timelines.ts";
import styles from "./archives.module.css";

/** Only in history mode, and only when there is an archive to choose besides the live recording. */
export function TimelinePicker() {
  const history = useHistoryPresentation();
  const { timelines, timeline } = history;
  if (history.mode !== "history" || !timeline || timelines.length < 2) return null;
  return (
    <>
      <label htmlFor="history-timeline">Timeline</label>
      <select
        id="history-timeline"
        className={styles.picker}
        value={timeline.id}
        disabled={history.pending}
        onChange={(event) => history.openTimeline(event.currentTarget.value)}
      >
        {timelines.map((choice) => (
          <option key={choice.id} value={choice.id}>
            {choiceText(choice)}
          </option>
        ))}
      </select>
      {timeline.archiveKind === "git" ? <span className={styles.gitChip}>Git</span> : null}
    </>
  );
}
