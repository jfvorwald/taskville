import { Anchored } from "../../../overlays/host/AnchorLayer.tsx";
import { agentAnchorId } from "../../movement/AgentLabels.tsx";
import styles from "./file-screen.module.css";
import { fileScreenLabel } from "./label.ts";

export interface FileScreenProps {
  /** The selected agent; nothing renders without one. */
  agentId: string | null;
  /** The agent's current file. Only its base name is shown. */
  path: string | null | undefined;
}

/**
 * The floating current-file screen above the selected agent's workstation. Plain text only: the
 * label is a React text node, never markup. Render it inside an `AnchorLayer`.
 */
export function FileScreen({ agentId, path }: FileScreenProps) {
  if (agentId === null) return null;
  return (
    <Anchored id="file-screen" anchorId={agentAnchorId(agentId)} priority={-1}>
      {/* The name tag is in another anchor layer at the same point, so lift clear of it. */}
      <div className={styles.lift}>
        <div className={styles.screen} data-testid="file-screen">
          {fileScreenLabel(path)}
        </div>
      </div>
    </Anchored>
  );
}
