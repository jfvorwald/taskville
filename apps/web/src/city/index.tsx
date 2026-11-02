import { useEffect } from "react";
import { useData } from "../data/react.ts";
import { type DataStore, dataStore } from "../data/store.ts";
import { useHistoryPresentation } from "../history/ui/HistoryProvider.tsx";
import { ThemedCity } from "../themes/core/index.ts";
import { useReducedMotion } from "../wiring/index.ts";
import { Celebrations } from "./effects/index.ts";
import { InteractionLayer } from "./interaction/index.ts";
import { DayNightLighting, lightingController } from "./lighting/index.ts";
import { CityAgents } from "./movement/index.ts";

/**
 * The 3D city, mounted inside the scene's `<Canvas>`. Later tickets add their component here
 * with a one-line edit (an import and one element). `DayNightLighting` comes after `ThemedCity`
 * on purpose: it owns the lights and the sky, and its background write must run second.
 */
export function CityRoot({
  store = dataStore,
  mode = "live",
  historyTime = null,
}: {
  store?: DataStore;
  mode?: "live" | "history";
  historyTime?: number | null;
}) {
  const reducedMotion = useReducedMotion();
  const presentation = useHistoryPresentation();
  useEffect(() => {
    lightingController.setTime(mode === "history" ? historyTime : null);
    return () => lightingController.setTime(null);
  }, [mode, historyTime]);
  const historySequence = useData(
    (state) => (mode === "history" ? state.state?.head : undefined),
    store,
  );
  return (
    <>
      <ThemedCity />
      <DayNightLighting />
      <CityAgents
        key={mode === "history" ? `history:${historySequence}` : "live"}
        store={store}
        reducedMotion={reducedMotion}
      />
      <Celebrations
        key={`${mode}:${mode === "history" ? presentation.fidelity.epoch : "live"}`}
        store={store}
        mode={mode}
        fidelity={presentation.fidelity}
        rate={mode === "history" ? presentation.rate : 1}
        reducedMotion={reducedMotion}
      />
      <InteractionLayer reducedMotion={reducedMotion} />
    </>
  );
}
