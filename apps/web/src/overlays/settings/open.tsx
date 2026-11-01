import { createContext, useContext, useEffect, useState } from "react";
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

const TOGGLE_ATTRIBUTE = "data-settings-toggle";

/** Set when a toggle was pressed, so the button that takes its place can keep the keyboard. */
let refocusToggle = false;

/** What a Settings button does when pressed: flip the state and ask for focus to stay on one. */
export function useToggleSettings([open, setOpen]: SettingsOpenState): () => void {
  return () => {
    refocusToggle = true;
    setOpen(!open);
  };
}

/**
 * The panel's button and the floating one are different elements, so pressing one unmounts it
 * when the sidebar switches. After that render, focus moves to whichever Settings button is shown.
 */
export function useKeepToggleFocus(open: boolean, sidebar: string | null) {
  // biome-ignore lint/correctness/useExhaustiveDependencies: a change of either is the trigger.
  useEffect(() => {
    if (!refocusToggle) return;
    refocusToggle = false;
    document.querySelector<HTMLElement>(`[${TOGGLE_ATTRIBUTE}]`)?.focus();
  }, [open, sidebar]);
}

/**
 * The Settings button for when the sidebar is showing something else, so it stays reachable
 * whatever is selected. It sits above the sidebar, where the panel's own button would be.
 */
export function SettingsToggle() {
  const state = useSettingsOpen();
  const [open] = state;
  const toggle = useToggleSettings(state);
  return (
    <InteractiveRegion className={styles.floatingToggle} data-settings-floating="">
      <Button
        className={styles.toggle}
        aria-expanded={open}
        aria-controls="settings-panel-body"
        data-settings-toggle=""
        onPress={toggle}
      >
        Settings
      </Button>
    </InteractiveRegion>
  );
}
