import { createContext, type ReactNode, useContext, useMemo } from "react";
import { useData } from "../../data/react.ts";
import { type DataStore, dataStore } from "../../data/store.ts";
import { ACTION_CARD_ID, ActionCard, type CardTarget } from "../../overlays/action-card/index.ts";
import { AGENT_PANEL_ID, AgentPanel } from "../../overlays/agent-panel/shell/index.ts";
import type { OverlayDefinition, OverlayProps } from "../../overlays/host/types.ts";
import { useHistoryPresentation } from "./HistoryProvider.tsx";
import { recordedCardTarget } from "./recordedTarget.ts";

interface Presented {
  store: DataStore;
  recordedTarget: CardTarget | null | undefined;
}

const Context = createContext<Presented>({ store: dataStore, recordedTarget: undefined });

/** The card the recording shows for the selection at the replayed head; undefined outside history. */
export function useRecordedTarget(
  store: DataStore,
  mode: "live" | "history",
  selectedId: string | null,
): CardTarget | null | undefined {
  const { moments } = useHistoryPresentation();
  const state = useData((s) => s.state, store);
  return useMemo(
    () => (mode === "history" ? recordedCardTarget({ state, moments, selectedId }) : undefined),
    [mode, state, moments, selectedId],
  );
}

/**
 * What the sidebar overlays present: the live store as is, or in history the replayed store and the
 * card the recording shows for the selection. The registry is module-wide, so the overlays below
 * read this instead of being rebuilt for each store.
 */
export function PresentedSidebar({
  store,
  recordedTarget,
  children,
}: Presented & { children: ReactNode }) {
  const value = useMemo(() => ({ store, recordedTarget }), [store, recordedTarget]);
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

function PresentedActionCard(props: OverlayProps) {
  const { store, recordedTarget } = useContext(Context);
  return <ActionCard {...props} store={store} recordedTarget={recordedTarget} />;
}

function PresentedAgentPanel(props: OverlayProps) {
  const { store } = useContext(Context);
  return <AgentPanel {...props} store={store} />;
}

export const presentedActionCardOverlay: OverlayDefinition = {
  id: ACTION_CARD_ID,
  slot: "sidebar",
  modes: ["live", "history"],
  Component: PresentedActionCard,
};

export const presentedAgentPanelOverlay: OverlayDefinition = {
  id: AGENT_PANEL_ID,
  slot: "sidebar",
  modes: ["live", "history"],
  Component: PresentedAgentPanel,
};
