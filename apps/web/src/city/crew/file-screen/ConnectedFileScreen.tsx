import { useData } from "../../../data/react.ts";
import { currentFile } from "../../../overlays/agent-panel/shell/facts.ts";
import { AnchorLayer } from "../../../overlays/host/AnchorLayer.tsx";
import type { OverlayDefinition, OverlayProps } from "../../../overlays/host/types.ts";
import { useSelection } from "../../interaction/index.ts";
import { FileScreen } from "./FileScreen.tsx";

/** The selected agent's file screen, in the world-labels slot. */
export function ConnectedFileScreen({ anchors }: OverlayProps) {
  const { selectedId } = useSelection();
  const toolCalls = useData((s) => s.state?.toolCalls);
  const agents = useData((s) => s.state?.agents);
  const agentId =
    selectedId !== null && agents !== undefined && Object.hasOwn(agents, selectedId)
      ? selectedId
      : null;
  return (
    <AnchorLayer source={anchors} gap={4} margin={48}>
      <FileScreen
        agentId={agentId}
        path={agentId !== null && toolCalls ? currentFile(agentId, toolCalls) : null}
      />
    </AnchorLayer>
  );
}

export const fileScreenOverlay: OverlayDefinition = {
  id: "file-screen",
  slot: "world-labels",
  modes: ["live"],
  Component: ConnectedFileScreen,
};
