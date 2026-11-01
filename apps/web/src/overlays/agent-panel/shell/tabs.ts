import { type FamilyAgent, hasChildren } from "./family.ts";

/** The panel's tabs, in the order they are shown. */
export const PANEL_TABS = ["live", "files", "crew"] as const;
export type PanelTab = (typeof PANEL_TABS)[number];

/** Live and Files for every agent; Crew for a lead, or for an agent that is a parent. */
export function visibleTabs(agentId: string, agents: readonly FamilyAgent[]): PanelTab[] {
  const agent = agents.find((a) => a.id === agentId);
  if (agent === undefined) return [];
  const crew = agent.kind === "lead" || hasChildren(agentId, agents);
  return PANEL_TABS.filter((tab) => tab !== "crew" || crew);
}
