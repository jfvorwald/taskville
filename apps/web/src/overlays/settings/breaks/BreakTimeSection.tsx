import { useSyncExternalStore } from "react";
import styles from "../settings.module.css";
import { getSettingsStore, type SettingsStore } from "../store.ts";

export interface BreakTimeSectionProps {
  /** Defaults to the app-wide store; tests pass their own. */
  store?: SettingsStore;
}

/**
 * Break time (M9.04). On marks a waiting agent on a break with an "on break" note; off shows the
 * plain Waiting label as before.
 */
export function BreakTimeSection({ store = getSettingsStore() }: BreakTimeSectionProps) {
  const values = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  return (
    <div className={styles.group}>
      <label className={styles.check}>
        <input
          type="checkbox"
          role="switch"
          checked={values.breakTime}
          aria-checked={values.breakTime}
          onChange={(event) => store.set("breakTime", event.target.checked)}
        />
        Break time
      </label>
      <p className={styles.note}>Show an "on break" note on waiting agents that are on a break.</p>
    </div>
  );
}
