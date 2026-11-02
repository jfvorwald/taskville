import { useAttentionReady, useNeedsYouTotal } from "../../overlays/header/attentionSync.ts";
import styles from "./back-to-live.module.css";
import { useHistoryPresentation } from "./HistoryProvider.tsx";

export function BackToLive() {
  const history = useHistoryPresentation();
  const ready = useAttentionReady();
  const total = useNeedsYouTotal();
  const needsYou = ready ? total : 0;
  if (history.mode !== "history") return null;
  return (
    <button
      type="button"
      className={styles.pill}
      data-needs-you={needsYou > 0}
      onClick={history.exit}
    >
      Back to live{needsYou > 0 ? ` · ${needsYou} needs you` : ""}
    </button>
  );
}
