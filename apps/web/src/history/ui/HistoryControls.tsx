import { useEffect } from "react";
import type { ReplayRate } from "../state/store.ts";
import { BackToLive } from "./back-to-live.tsx";
import { useHistoryPresentation } from "./HistoryProvider.tsx";
import { HistoryTimeline } from "./HistoryTimeline.tsx";
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
  const range = history.range;
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
      <BackToLive />
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
      {history.mode === "history" && range && history.time !== null ? (
        <div className={styles.timeline}>
          <label htmlFor="history-time">Timeline time</label>
          <input
            id="history-time"
            type="range"
            min={range.first}
            max={range.last}
            step={1}
            value={history.sequence ?? range.first}
            aria-valuetext={new Date(history.time).toLocaleString()}
            onChange={(event) => history.seek(Number(event.currentTarget.value))}
          />
          <HistoryTimeline />
          <button type="button" onClick={history.playing ? history.pause : history.play}>
            {history.playing ? "Pause" : "Play"}
          </button>
          <label htmlFor="history-speed">Playback speed</label>
          <select
            id="history-speed"
            value={history.rate}
            onChange={(event) => history.setRate(Number(event.currentTarget.value) as ReplayRate)}
          >
            {[1, 10, 60, 600].map((rate) => (
              <option key={rate} value={rate}>
                {rate}x
              </option>
            ))}
          </select>
          <button type="button" onClick={history.exit}>
            Return live
          </button>
        </div>
      ) : null}
    </>
  );
}
