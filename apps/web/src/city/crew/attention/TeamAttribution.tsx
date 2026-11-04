import { useFrame } from "@react-three/fiber";
import { useMemo, useRef } from "react";
import type { Group } from "three";
import { useData } from "../../../data/react.ts";
import type { DataStore } from "../../../data/store.ts";
import { LabelSprite } from "../../agents/LabelSprite.tsx";
import { colorMaterial } from "../../agents/resources.ts";
import type { AgentView } from "../../agents/types.ts";
import { useAttributedView } from "../strict-attribution/index.ts";
import { crewGeometries } from "../subagents/resources.ts";
import { crewAttribution, leadDotTargets } from "./attribution.ts";

// M5.10: what a team lead wears when someone on its team needs you (ARCHITECTURE 2.9, #120). The
// red state itself is the existing M4 mark on the attributed agent, and a subagent's parent dot
// is SubagentCrew's; this adds the lead's red dot for a stuck teammate and the "for: <teammate>"
// label when the attribution is indirect (split-pane, heuristic).

const RED = "#d9534f";

function LeadMarks({
  view,
  dot,
  label,
}: {
  view: AgentView;
  dot: boolean;
  label: string | undefined;
}) {
  const root = useRef<Group>(null);
  useFrame(() => {
    const p = view.placement;
    root.current?.position.set(p.x, p.y, p.z);
  });
  return (
    <group ref={root}>
      {dot && (
        <mesh
          position={[0.2, 1.3, 0]}
          geometry={crewGeometries().dot}
          material={colorMaterial(RED)}
          userData={{ needsYouDot: view.id }}
        />
      )}
      {label !== undefined && (
        <LabelSprite name={label} status="Guessed from text" y={2.1} inverseScale={1} />
      )}
    </group>
  );
}

export function TeamAttribution({
  views,
  store,
}: {
  views: readonly AgentView[];
  store: DataStore;
}) {
  const state = useData((s) => s.state, store);
  const attention = useData((s) => s.attention, store);
  const slice = useMemo(
    () => ({ agents: state?.agents ?? {}, teams: state?.teams ?? {}, attention }),
    [state, attention],
  );
  const attributed = useAttributedView(slice);
  const out = useMemo(
    () => (state === null ? undefined : crewAttribution(attributed)),
    [state, attributed],
  );
  if (out === undefined || state === null) return null;
  return (
    <>
      {views
        .filter((v) => v.kind === "lead")
        .map((v) => {
          // SubagentCrew dots a lead's own subagents; the lead's dot here is for the teammate side.
          const mates = leadDotTargets(out, state.agents, v.id);
          const label = out.forLabels[v.id]?.text;
          return mates.length === 0 && label === undefined ? null : (
            <LeadMarks key={v.id} view={v} dot={mates.length > 0} label={label} />
          );
        })}
    </>
  );
}
