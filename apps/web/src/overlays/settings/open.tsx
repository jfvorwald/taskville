import { createContext, useContext, useState } from "react";
import { Button } from "react-aria-components";
import { InteractiveRegion } from "../host/InteractiveRegion.tsx";
import styles from "./settings.module.css";

/** Whether the settings body is open, and how to change it. */
export type SettingsOpenState = readonly [open: boolean, setOpen: (open: boolean) => void];

/**
 * The open state when something above the panel owns it. The panel unmounts whenever the sidebar
 * shows something else, so a panel that kept it locally would forget it. Without a provider the
 * panel keeps its own.
 */
export const SettingsOpenContext = createContext<SettingsOpenState | null>(null);

export function useSettingsOpen(): SettingsOpenState {
  const owned = useContext(SettingsOpenContext);
  const local = useState(false);
  return owned ?? local;
}

/**
 * The Settings button for when the sidebar is showing something else, so it stays reachable
 * whatever is selected. It sits above the sidebar, where the panel's own button would be.
 */
export function SettingsToggle() {
  const [open, setOpen] = useSettingsOpen();
  return (
    <InteractiveRegion className={styles.floatingToggle}>
      <Button
        className={styles.toggle}
        aria-expanded={open}
        aria-controls="settings-panel-body"
        onPress={() => setOpen(!open)}
      >
        Settings
      </Button>
    </InteractiveRegion>
  );
}
