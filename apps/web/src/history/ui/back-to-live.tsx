import { useAttentionReady, useNeedsYouTotal } from "../../overlays/header/attentionSync.ts";
import styles from "./back-to-live.module.css";
import { useHistoryPresentation } from "./HistoryProvider.tsx";

export function BackToLive() {
  const history = useHistoryPresentation();
  const ready = useAttentionReady();
  const total = useNeedsYouTotal();
  const needsYou = ready ? total : 0;
  const [top, setTop] = useState(64);
  useLayoutEffect(() => {
    if (history.mode !== "history") return;
    // The header can grow when live project chips wrap; keep both controls visible.
    const header = document.querySelector<HTMLElement>('[data-slot="header"]');
    if (header === null) return;
    const place = () => setTop(Math.max(64, header.getBoundingClientRect().bottom + 8));
    place();
    const observer = new ResizeObserver(place);
    observer.observe(header);
    return () => observer.disconnect();
  }, [history.mode]);
  if (history.mode !== "history") return null;
  return (
    <button
      type="button"
      className={styles.pill}
      style={{ top }}
      data-needs-you={needsYou > 0}
      onClick={history.exit}
    >
      Back to live{needsYou > 0 ? ` · ${needsYou} needs you` : ""}
    </button>
  );
}

import { useLayoutEffect, useState } from "react";
