import { useState, useSyncExternalStore } from "react";
import { Button, Label, Radio, RadioGroup, Switch } from "react-aria-components";
import { InteractiveRegion } from "../host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayProps } from "../host/types.ts";
import { SoundSection } from "./SoundSection.tsx";
import styles from "./settings.module.css";
import {
  type DayNight,
  DEFAULT_SETTINGS,
  getSettingsStore,
  type ReducedMotionSetting,
  SETTINGS_OVERLAY_ID,
  type SettingsStore,
} from "./store.ts";

export interface ThemeOption {
  id: string;
  label: string;
}

/** Until the theme system (M3.07) supplies its list, the one theme that exists. */
const DEFAULT_THEMES: readonly ThemeOption[] = [{ id: "cyberpunk", label: "Cyberpunk" }];

export interface SettingsPanelProps extends OverlayProps {
  /** Defaults to the app-wide store; tests and the theme system pass their own. */
  store?: SettingsStore;
  themes?: readonly ThemeOption[];
  /** The theme in use, when that is not the stored setting. Defaults to the stored setting. */
  themeId?: string;
  /** Called with the chosen theme. Defaults to storing it. */
  onThemeChange?: (id: string) => void;
}

/**
 * The settings sidebar: theme, day or night, reduced motion, and placeholders for sound and code
 * privacy. Values live in the settings store (local to this viewer), not in the engine.
 */
export function SettingsPanel({
  store = getSettingsStore(),
  themes = DEFAULT_THEMES,
  themeId,
  onThemeChange = (id) => store.set("theme", id),
}: SettingsPanelProps) {
  const values = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [open, setOpen] = useState(false);
  // The theme system falls back to the default for an unknown id, so the panel shows that.
  const inUse = themeId ?? values.theme;
  const theme = themes.some((t) => t.id === inUse) ? inUse : DEFAULT_SETTINGS.theme;

  return (
    <InteractiveRegion className={styles.panel}>
      <Button
        className={styles.toggle}
        aria-expanded={open}
        aria-controls="settings-panel-body"
        onPress={() => setOpen((o) => !o)}
      >
        Settings
      </Button>
      {open ? (
        <div id="settings-panel-body" className={styles.body}>
          <RadioGroup className={styles.group} value={theme} onChange={onThemeChange}>
            <Label className={styles.legend}>Theme</Label>
            {themes.map((t) => (
              <Radio key={t.id} value={t.id} className={styles.radio}>
                {t.label}
              </Radio>
            ))}
          </RadioGroup>

          <RadioGroup
            className={styles.group}
            value={values.dayNight}
            onChange={(v) => store.set("dayNight", v as DayNight)}
          >
            <Label className={styles.legend}>Day and night</Label>
            <Radio value="auto" className={styles.radio}>
              Auto
            </Radio>
            <Radio value="day" className={styles.radio}>
              Day
            </Radio>
            <Radio value="night" className={styles.radio}>
              Night
            </Radio>
          </RadioGroup>

          <RadioGroup
            className={styles.group}
            value={values.reducedMotion}
            onChange={(v) => store.set("reducedMotion", v as ReducedMotionSetting)}
          >
            <Label className={styles.legend}>Reduced motion</Label>
            <Radio value="system" className={styles.radio}>
              Follow system
            </Radio>
            <Radio value="on" className={styles.radio}>
              Reduce
            </Radio>
            <Radio value="off" className={styles.radio}>
              Allow
            </Radio>
          </RadioGroup>

          <SoundSection />

          <Switch
            className={styles.switch}
            isDisabled
            aria-label="Sound"
            aria-describedby="settings-sound-note"
          >
            Sound
            <span id="settings-sound-note" className={styles.note}>
              Coming later
            </span>
          </Switch>
          <Switch
            className={styles.switch}
            isDisabled
            aria-label="Hide code in the city"
            aria-describedby="settings-hide-code-note"
          >
            Hide code in the city
            <span id="settings-hide-code-note" className={styles.note}>
              Coming later
            </span>
          </Switch>
        </div>
      ) : null}
    </InteractiveRegion>
  );
}

export const settingsOverlay: OverlayDefinition = {
  id: SETTINGS_OVERLAY_ID,
  slot: "sidebar",
  modes: ["live", "history"],
  Component: SettingsPanel,
};
