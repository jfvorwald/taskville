import { Fragment, type ReactNode, useEffect, useMemo, useState } from "react";
import { Button, Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { shouldClearOnEscape } from "../../../city/interaction/escape.ts";
import type { Agent } from "../../../data/domain.ts";
import { useData } from "../../../data/react.ts";
import { type DataStore, dataStore } from "../../../data/store.ts";
import { InteractiveRegion } from "../../host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayProps } from "../../host/types.ts";
import styles from "./agent-panel.module.css";
import { currentFile, elapsedMs, formatElapsed } from "./facts.ts";
import { familyPath, stepFamily } from "./family.ts";
import { type PanelTab, visibleTabs } from "./tabs.ts";

export const AGENT_PANEL_ID = "agent-panel";

/** How often the elapsed time is recomputed from the store clock. */
const CLOCK_TICK_MS = 1000;
const ID_SHORT = 8;

const TAB_LABEL: Record<PanelTab, string> = { live: "Live", files: "Files", crew: "Crew" };
const KIND_LABEL: Record<Agent["kind"], string> = {
  lead: "Lead",
  teammate: "Teammate",
  subagent: "Subagent",
  session: "Session",
  unknown: "Unknown",
};

export interface AgentPanelProps extends OverlayProps {
  /** Defaults to the app-wide store; tests pass their own. */
  store?: DataStore;
  /** The content of the selected tab. The shell draws none of its own (M5.06 to M5.08). */
  renderTab?: (tab: PanelTab, agentId: string) => ReactNode;
}

/** "handing_off" is read as "Handing off", the same words the world labels use. */
function activityText(activity: string): string {
  const words = activity.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function nameOf(agent: Agent): string {
  return agent.displayName ?? Array.from(agent.id).slice(0, ID_SHORT).join("");
}

/**
 * A key event the panel may act on: not one that a text field, a dialog or an earlier handler owns.
 * This is the Escape rule of the city, applied to the panel's bracket keys too.
 */
function isFree(event: KeyboardEvent): boolean {
  return shouldClearOnEscape({
    key: "Escape",
    defaultPrevented: event.defaultPrevented,
    target: event.target,
  } as KeyboardEvent);
}

/**
 * The agent panel shell: who the agent is, where it sits in its family, and the tab slot the tab
 * tickets fill. It shows nothing unless the selection is an agent the store knows. In history mode
 * it is read-only: the only thing it changes is the selection.
 */
export function AgentPanel({ mode, selection, store = dataStore, renderTab }: AgentPanelProps) {
  const state = useData((s) => s.state, store);
  const attention = useData((s) => s.attention, store);
  const [nowMs, setNowMs] = useState(() => store.now());
  const [chosen, setChosen] = useState<PanelTab>("live");

  useEffect(() => {
    setNowMs(store.now());
    const timer = setInterval(() => setNowMs(store.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [store]);

  const byId = state?.agents;
  const agents = useMemo(() => Object.values(byId ?? {}), [byId]);
  const selectedId = selection.selectedId;
  const agent =
    selectedId === null || byId === undefined || !Object.hasOwn(byId, selectedId)
      ? undefined
      : byId[selectedId];
  const known = agent !== undefined;
  const { select } = selection;

  useEffect(() => {
    if (!known || selectedId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (shouldClearOnEscape(event)) select(null);
        return;
      }
      if ((event.key !== "[" && event.key !== "]") || !isFree(event)) return;
      const next = stepFamily(selectedId, agents, event.key === "]" ? 1 : -1);
      if (next !== null) select(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [known, selectedId, agents, select]);

  if (agent === undefined || state === null) return null;

  const needsYou = attention.some((a) => a.agentId === agent.id && a.level === "needs_you");
  const recorded = state.activity[agent.id];
  // A heuristic activity is a guess (constitution IV), so the header says so.
  const status = needsYou
    ? "Needs you"
    : recorded?.heuristic === true
      ? `Possibly ${activityText(recorded.activity).toLowerCase()}`
      : activityText(recorded?.activity ?? "unknown");
  const elapsed = elapsedMs(agent, nowMs);
  const file = currentFile(agent.id, state.toolCalls);
  const crumbs = familyPath(agent.id, agents);
  const tabs = visibleTabs(agent.id, agents);
  const active = tabs.includes(chosen) ? chosen : "live";

  return (
    <InteractiveRegion
      className={styles.panel}
      data-testid="agent-panel"
      data-agent-id={agent.id}
      data-kind={agent.kind}
      data-readonly={mode === "history" ? "true" : undefined}
    >
      <nav aria-label="Family" className={styles.crumbs}>
        {crumbs.map((id, i) => {
          const member = byId?.[id];
          if (member === undefined) return null;
          return (
            <Fragment key={id}>
              {i > 0 ? (
                <span aria-hidden="true" className={styles.separator}>
                  /
                </span>
              ) : null}
              <Button
                className={styles.crumb}
                {...(id === agent.id ? { "aria-current": "true" as const } : {})}
                onPress={() => select(id)}
              >
                {nameOf(member)}
              </Button>
            </Fragment>
          );
        })}
      </nav>
      <header className={styles.header}>
        <h2 className={styles.name} data-testid="agent-panel-name">
          {nameOf(agent)}
        </h2>
        <p className={styles.facts}>
          <span data-testid="agent-panel-type">{agent.role ?? KIND_LABEL[agent.kind]}</span>
          <span data-testid="agent-panel-status" data-urgent={needsYou ? "true" : undefined}>
            {status}
          </span>
          {elapsed === null ? null : (
            <span data-testid="agent-panel-elapsed">{formatElapsed(elapsed)}</span>
          )}
        </p>
        {file === null ? null : (
          <p className={styles.file} data-testid="agent-panel-file">
            {file}
          </p>
        )}
      </header>
      <Tabs
        className={styles.tabs}
        selectedKey={active}
        onSelectionChange={(key) => setChosen(key as PanelTab)}
      >
        <TabList aria-label="Agent views" className={styles.tabList}>
          {tabs.map((tab) => (
            <Tab key={tab} id={tab} className={styles.tab}>
              {TAB_LABEL[tab]}
            </Tab>
          ))}
        </TabList>
        <TabPanel
          id={active}
          className={styles.slot}
          data-testid="agent-panel-tab-slot"
          data-tab={active}
        >
          {renderTab?.(active, agent.id)}
        </TabPanel>
      </Tabs>
    </InteractiveRegion>
  );
}

export const agentPanelOverlay: OverlayDefinition = {
  id: AGENT_PANEL_ID,
  slot: "sidebar",
  modes: ["live", "history"],
  Component: AgentPanel,
};
