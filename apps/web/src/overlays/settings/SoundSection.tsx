import { useState, useSyncExternalStore } from "react";
import {
  Button,
  Label,
  Slider,
  SliderOutput,
  SliderThumb,
  SliderTrack,
  Switch,
} from "react-aria-components";
import {
  getSoundSettingsStore,
  getSoundscape,
  type SoundSettingsStore,
  type Soundscape,
} from "../../audio/index.ts";
import styles from "./settings.module.css";

export interface SoundSectionProps {
  /** Default to the app-wide ones; tests pass their own. */
  soundscape?: Soundscape;
  store?: SoundSettingsStore;
}

/**
 * Sound controls (ARCHITECTURE.md 2.7). Sound is off until the viewer presses the button: that
 * click is what lets the browser play audio. Volume, mute and chime-only are remembered.
 */
export function SoundSection({
  soundscape = getSoundscape(),
  store = getSoundSettingsStore(),
}: SoundSectionProps) {
  const values = useSyncExternalStore(store.subscribe, store.getSnapshot, store.getSnapshot);
  const [on, setOn] = useState(soundscape.enabled);
  const [failed, setFailed] = useState(false);

  const toggle = async () => {
    if (on) {
      soundscape.disable();
      setOn(false);
      return;
    }
    // Called straight from the click, so the browser lets the audio context start.
    try {
      await soundscape.enable();
    } catch {
      // The browser refused to start audio: stay on "Enable sound" so the viewer can try again.
      setFailed(true);
      setOn(false);
      return;
    }
    setFailed(false);
    setOn(soundscape.enabled);
  };

  return (
    <fieldset className={`${styles.group} ${styles.fieldset}`}>
      <legend className={styles.legend}>Sound</legend>
      <Button className={styles.action} onPress={toggle}>
        {on ? "Turn sound off" : "Enable sound"}
      </Button>
      {failed ? (
        <span role="status" className={styles.note}>
          Sound could not start. Try again.
        </span>
      ) : null}
      <Slider
        className={styles.slider}
        minValue={0}
        maxValue={1}
        step={0.05}
        value={values.volume}
        onChange={(v) => store.set("volume", v)}
      >
        <div className={styles.sliderHead}>
          <Label>Volume</Label>
          <SliderOutput>{({ state }) => `${Math.round(state.values[0] * 100)}%`}</SliderOutput>
        </div>
        <SliderTrack className={styles.track}>
          <SliderThumb className={styles.thumb} />
        </SliderTrack>
      </Slider>
      <Switch
        className={styles.switch}
        isSelected={values.muted}
        onChange={(v) => store.set("muted", v)}
      >
        Mute
      </Switch>
      <Switch
        className={styles.switch}
        isSelected={values.chimeOnly}
        onChange={(v) => store.set("chimeOnly", v)}
      >
        Chime only
      </Switch>
    </fieldset>
  );
}
