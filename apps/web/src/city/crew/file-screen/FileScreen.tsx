import { Anchored } from "../../../overlays/host/AnchorLayer.tsx";
import { agentAnchorId } from "../../movement/anchorId.ts";
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
 * label is a React text node, never markup. Render it inside an `AnchorLayer`; at a lower priority
 * than the name tags, so a collision lifts the screen and never a tag.
 */
export function FileScreen({ agentId, path }: FileScreenProps) {
  if (agentId === null) return null;
  return (
    <Anchored id="file-screen" anchorId={agentAnchorId(agentId)} priority={-1}>
      <div className={styles.screen} data-testid="file-screen">
        {fileScreenLabel(path)}
      </div>
    </Anchored>
  );
}
