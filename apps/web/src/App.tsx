import { useEffect } from "react";
import { HistoryProvider } from "./history/index.ts";
import { PairingNotice } from "./pairing/PairingNotice.tsx";
import { SessionProvider, usePairing } from "./pairing/session.tsx";
import { SceneRoot } from "./SceneRoot.tsx";
import { startWiring } from "./wiring/index.ts";

/** Pairs first. Nothing that asks the engine for data renders until the page is paired. */
export function App() {
  const { state, retry } = usePairing();
  useEffect(startWiring, []);
  if (state.status === "checking") return null;
  if (state.status === "paired") {
    return (
      <SessionProvider value={state.secret}>
        <HistoryProvider>
          <SceneRoot />
        </HistoryProvider>
      </SessionProvider>
    );
  }
  return <PairingNotice state={state} onRetry={retry} />;
}
