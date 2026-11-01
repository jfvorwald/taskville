import { useEffect } from "react";
import { useHistoryPresentation } from "./HistoryProvider.tsx";
import styles from "./history.module.css";

function editing(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable || target.closest('textarea, select, [role="textbox"]')) return true;
  return (
    target instanceof HTMLInputElement &&
    !["range", "button", "checkbox", "radio", "submit", "reset"].includes(target.type)
  );
}

export function HistoryControls() {
  const history = useHistoryPresentation();
  useEffect(() => {
    function keydown(event: KeyboardEvent) {
      if (
        event.defaultPrevented ||
        event.repeat ||
        event.ctrlKey ||
        event.metaKey ||
        event.altKey ||
        editing(event.target)
      )
        return;
      const key = event.key.toLowerCase();
      if (key === "h" && history.mode === "live") {
        event.preventDefault();
        history.enter();
      } else if (
        (key === "escape" || key === "l") &&
        (history.mode === "history" || history.pending)
      ) {
        event.preventDefault();
        history.exit();
      }
    }
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [history]);
  return (
    <>
      <div className={styles.header}>
        <button
          type="button"
          onClick={history.enter}
          disabled={history.pending || history.mode === "history"}
          aria-label="History"
        >
          ◷ History
        </button>
        {history.mode === "history" && history.time !== null ? (
          <span>HISTORY · {new Date(history.time).toLocaleString()}</span>
        ) : null}
        {history.error ? <span role="status">{history.error}</span> : null}
      </div>
      {history.mode === "history" && history.range && history.time !== null ? (
        <div className={styles.timeline}>
          <label htmlFor="history-time">Timeline time</label>
          <input
            id="history-time"
            type="range"
            min={history.range.first}
            max={history.range.last}
            step={1}
            value={history.time}
            aria-valuetext={new Date(history.time).toLocaleString()}
            onChange={(event) => history.seek(Number(event.currentTarget.value))}
          />
          <button type="button" onClick={history.exit}>
            Return live
          </button>
        </div>
      ) : null}
    </>
  );
}
