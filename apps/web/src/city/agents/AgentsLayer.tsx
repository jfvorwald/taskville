import { useEffect, useMemo } from "react";
import { AgentBlock } from "./AgentBlock.tsx";
import { buildLabelEntries } from "./labelEntries.ts";
import type { AgentLabelEntry, AgentView } from "./types.ts";

export interface AgentsLayerProps {
  agents: readonly AgentView[];
  reducedMotion?: boolean;
  /**
   * Hands label text and world anchors to the world-labels slot (M3.03). Called when text or
   * the agent set changes. When set, the local fallback labels are not drawn.
   */
  onLabels?: (entries: readonly AgentLabelEntry[]) => void;
}

/** All block agents, mounted inside the scene's `<Canvas>`. */
export function AgentsLayer({ agents, reducedMotion = false, onLabels }: AgentsLayerProps) {
  const entries = useMemo(() => buildLabelEntries(agents), [agents]);
  useEffect(() => {
    onLabels?.(entries);
    return () => onLabels?.([]);
  }, [entries, onLabels]);

  return (
    <>
      {agents.map((agent) => (
        <AgentBlock
          key={agent.id}
          agent={agent}
          reducedMotion={reducedMotion}
          localLabel={onLabels === undefined}
        />
      ))}
    </>
  );
}
