import { useSyncExternalStore } from "react";
import styles from "../settings.module.css";
import { getSettingsStore, type SettingsStore } from "../store.ts";

export interface StrictAttributionSectionProps {
  /** Defaults to the app-wide store; tests pass their own. */
  store?: SettingsStore;
}

/**
 * Strict teammate attribution (decision #120 D2). Off shows the guesses made from message text;
 * on shows only what the session files record.
 */
export function StrictAttributionSection({
  store = getSettingsStore(),
}: StrictAttributionSectionProps) {
  const values = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <div className={styles.group}>
      <label className={styles.check}>
        <input
          type="checkbox"
          role="switch"
          checked={values.strictAttribution}
          aria-checked={values.strictAttribution}
          onChange={(event) => store.set("strictAttribution", event.target.checked)}
        />
        Strict teammate attribution
      </label>
      <p className={styles.note}>
        Show only teammate links the session files record, not guesses from message text.
      </p>
    </div>
  );
}
