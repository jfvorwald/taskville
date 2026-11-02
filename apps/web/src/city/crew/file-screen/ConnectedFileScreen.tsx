import { useEffect } from "react";
import { useData } from "../../../data/react.ts";
import { currentFile } from "../../../overlays/agent-panel/shell/facts.ts";
import type { OverlayDefinition, OverlayProps } from "../../../overlays/host/types.ts";
import { useSelection } from "../../interaction/index.ts";
import { fileScreenStore } from "./fileScreenStore.ts";

/**
 * Publishes the selected agent's current file for the file screen. It draws nothing itself: the
 * agent labels layer renders the screen, so one collision layer places it with the name tags.
 */
export function ConnectedFileScreen(_props: OverlayProps) {
  const { selectedId } = useSelection();
  const toolCalls = useData((s) => s.state?.toolCalls);
  const agents = useData((s) => s.state?.agents);
  const agentId =
    selectedId !== null && agents !== undefined && Object.hasOwn(agents, selectedId)
      ? selectedId
      : null;
  const path = agentId !== null && toolCalls ? currentFile(agentId, toolCalls) : null;
  useEffect(() => {
    fileScreenStore.set({ agentId, path });
    return () => fileScreenStore.set({ agentId: null, path: null });
  }, [agentId, path]);
  return null;
}

export const fileScreenOverlay: OverlayDefinition = {
  id: "file-screen",
  slot: "world-labels",
  modes: ["live"],
  Component: ConnectedFileScreen,
};
