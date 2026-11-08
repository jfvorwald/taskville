import { useHistoryPresentation } from "../ui/HistoryProvider.tsx";
import { choiceText } from "./archive-timelines.ts";
import styles from "./archives.module.css";

/** Only in history mode, and only when there is an archive to choose. */
export function TimelinePicker() {
  const history = useHistoryPresentation();
  const { timelines, timeline } = history;
  if (
    history.mode !== "history" ||
    !timeline ||
    !timelines.some((choice) => choice.kind === "archive")
  )
    return null;
  return (
    <>
      <label htmlFor="history-timeline">Timeline</label>
      <select
        id="history-timeline"
        className={styles.picker}
        value={timeline.id}
        title={timeline.label}
        aria-busy={history.pending}
        onFocus={history.refreshTimelines}
        onChange={(event) => {
          if (!history.pending) history.openTimeline(event.currentTarget.value);
        }}
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
