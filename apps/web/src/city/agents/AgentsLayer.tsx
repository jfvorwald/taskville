import { useEffect, useRef } from "react";
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
  /** The clock the attention marks pulse on; the data store's `now`. Default `Date.now`. */
  now?: () => number;
}

/** All block agents, mounted inside the scene's `<Canvas>`. */
export function AgentsLayer({ agents, reducedMotion = false, onLabels, now }: AgentsLayerProps) {
  // A store update replaces every `AgentView`, usually with the same text. Keep the previous
  // entries while the text is unchanged so the slot hears about real changes only.
  const stable = useRef<readonly AgentLabelEntry[]>([]);
  const next = buildLabelEntries(agents);
  if (!sameText(stable.current, next)) stable.current = next;
  const entries = stable.current;

  // An inline callback is a new function each render, so it is held in a ref, not a dependency.
  const notify = useRef(onLabels);
  notify.current = onLabels;
  // A callback that arrives after mount still gets the current entries once, so the effect also
  // depends on whether one is present, not on which function it is.
  const hasLabels = onLabels !== undefined;
  // biome-ignore lint/correctness/useExhaustiveDependencies: hasLabels re-runs the effect when a callback first appears
  useEffect(() => {
    notify.current?.(entries);
  }, [entries, hasLabels]);
  useEffect(
    () => () => {
      notify.current?.([]);
    },
    [],
  );

  return (
    <>
      {agents.map((agent) => (
        <AgentBlock
          key={agent.id}
          agent={agent}
          reducedMotion={reducedMotion}
          localLabel={onLabels === undefined}
          {...(now === undefined ? {} : { now })}
        />
      ))}
    </>
  );
}

function sameText(a: readonly AgentLabelEntry[], b: readonly AgentLabelEntry[]): boolean {
  return (
    a.length === b.length &&
    a.every((e, i) => {
      const o = b[i];
      return (
        o !== undefined &&
        e.id === o.id &&
        e.name === o.name &&
        e.status === o.status &&
        e.offsetY === o.offsetY
      );
    })
  );
}
