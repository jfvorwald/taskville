import {
  Fragment,
  type ReactNode,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";
import { Button, Tab, TabList, TabPanel, Tabs } from "react-aria-components";
import { breakNote } from "../../../city/agents/label.ts";
import {
  FEED_REQUEST_TTL_MS,
  type FeedFocus,
  feedFocus as sharedFeedFocus,
} from "../../../city/crew/envelopes/feedFocus.ts";
import { highlightStore } from "../../../city/crew/highlight/highlightStore.ts";
import { shouldClearOnEscape } from "../../../city/interaction/escape.ts";
import type { Agent } from "../../../data/domain.ts";
import { useData } from "../../../data/react.ts";
import { type DataStore, dataStore } from "../../../data/store.ts";
import { HowDidWeGetHere } from "../../../history/ui/how-did-we.tsx";
import { InteractiveRegion } from "../../host/InteractiveRegion.tsx";
import type { OverlayDefinition, OverlayProps } from "../../host/types.ts";
import { getSettingsStore } from "../../settings/store.ts";
import { displayPath } from "../code/displayPath.ts";
import { AgentCost, type CostSource, useAgentCost } from "../cost/index.ts";
import { CrewTab } from "../crew/CrewTab.tsx";
import { ConnectedFilesTab } from "../files/ConnectedFilesTab.tsx";
import { ConnectedLiveTab } from "../live/ConnectedLiveTab.tsx";
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
  /** Initial view when the panel mounts; selection changes retain the chosen view. */
  initialTab?: PanelTab;
  /** Overrides the selected tab content. Live and Files use paired feeds by default. */
  renderTab?: (tab: PanelTab, agentId: string) => ReactNode;
  /** Tokens and cost from Claude Code's OpenTelemetry export; defaults to the engine's endpoint. */
  costSource?: CostSource;
  /** How often the cost is asked for again while the agent stays selected. */
  costRefreshMs?: number;
  /** A clicked envelope asks for its sender's Live feed; defaults to the app-wide hand-off. */
  feedFocus?: FeedFocus;
  /** M9.04: ids of agents the break plan has on a break; the header adds an "on break" note. */
  onBreak?: ReadonlySet<string>;
}

/** "handing_off" is read as "Handing off", the same words the world labels use. */
function activityText(activity: string): string {
  const words = activity.replace(/_/g, " ");
  return words.charAt(0).toUpperCase() + words.slice(1);
}

function nameOf(agent: Agent): string {
  const name = agent.displayName;
  return name !== undefined && name.trim() !== ""
    ? name
    : Array.from(agent.id).slice(0, ID_SHORT).join("");
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
export function AgentPanel({
  mode,
  selection,
  store = dataStore,
  initialTab = "live",
  renderTab,
  costSource,
  costRefreshMs,
  feedFocus = sharedFeedFocus,
  onBreak,
}: AgentPanelProps) {
  const state = useData((s) => s.state, store);
  const attention = useData((s) => s.attention, store);
  const settings = getSettingsStore();
  const { privacyMode, breakTime } = useSyncExternalStore(
    settings.subscribe,
    settings.getSnapshot,
    settings.getSnapshot,
  );
  const [nowMs, setNowMs] = useState(() => store.now());
  const [chosen, setChosen] = useState<PanelTab>(initialTab);
  const focus = useSyncExternalStore(
    feedFocus.subscribe,
    feedFocus.getSnapshot,
    feedFocus.getSnapshot,
  );
  // A request made before the panel mounted still counts: the click that selected the agent may
  // have come first. Each request is acted on once, so nothing carries over to the next agent.
  const handledFocus = useRef<typeof focus>(null);
  // The SendMessage call a clicked envelope named, kept until the Live tab has focused its card.
  const [card, setCard] = useState<{ agentId: string; toolCallId: string } | null>(null);
  // A crumb press can remove the breadcrumb (the parent has no family of its own), which would
  // drop keyboard focus to the page: the heading takes it instead.
  const nameRef = useRef<HTMLHeadingElement>(null);
  const crumbPressed = useRef(false);

  // A clicked envelope for the selected agent opens its Live tab, and the Live tab focuses
  // its SendMessage card (M5.28). The selection may land a render after the request, so a request
  // waits for its agent to be selected.
  useEffect(() => {
    if (focus === null || focus === handledFocus.current || focus.agentId !== selection.selectedId)
      return;
    handledFocus.current = focus;
    // Single use: consumed here, so a remount does not apply it again. A stale one is only dropped.
    if (feedFocus.ageOf(focus) <= FEED_REQUEST_TTL_MS) {
      setChosen("live");
      setCard(
        focus.toolCallId === undefined
          ? null
          : { agentId: focus.agentId, toolCallId: focus.toolCallId },
      );
    }
    feedFocus.clear(focus);
  }, [focus, selection.selectedId, feedFocus]);
  // A pending card belongs to its agent: showing another one drops it.
  useEffect(() => {
    setCard((old) => (old === null || old.agentId === selection.selectedId ? old : null));
  }, [selection.selectedId]);

  useEffect(() => {
    setNowMs(store.now());
    const timer = setInterval(() => setNowMs(store.now()), CLOCK_TICK_MS);
    return () => clearInterval(timer);
  }, [store]);

  const byId = state?.agents;
  const agents = useMemo(() => Object.values(byId ?? {}), [byId]);
  const teams = state?.teams;
  const selectedId = selection.selectedId;
  const agent =
    selectedId === null || byId === undefined || !Object.hasOwn(byId, selectedId)
      ? undefined
      : byId[selectedId];
  const known = agent !== undefined;
  const costView = useAgentCost(agent?.id, costSource, costRefreshMs);
  const { select } = selection;

  useEffect(() => {
    if (!known || selectedId === null) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (shouldClearOnEscape(event)) select(null);
        return;
      }
      if ((event.key !== "[" && event.key !== "]") || !isFree(event)) return;
      // Browser and system shortcuts (Cmd+[ is back) and a held key are not a request to step.
      if (event.metaKey || event.ctrlKey || event.altKey || event.repeat) return;
      const next = stepFamily(selectedId, agents, event.key === "]" ? 1 : -1, teams);
      if (next !== null) select(next);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [known, selectedId, agents, teams, select]);

  const results = useMemo(() => {
    const out: Record<string, string> = {};
    for (const a of agents) {
      if (a.resultSummary !== undefined) {
        out[a.id] = privacyMode ? "Summary hidden by the privacy setting" : a.resultSummary;
      }
    }
    return out;
  }, [agents, privacyMode]);

  const openId = known && chosen === "crew" ? agent.id : null;
  // The city dims everyone outside the family while this agent's Crew tab is open.
  useEffect(() => {
    highlightStore.open(openId);
    return () => highlightStore.open(null);
  }, [openId]);

  const shownId = agent?.id;
  useEffect(() => {
    if (!crumbPressed.current || shownId === undefined) return;
    crumbPressed.current = false;
    const active = document.activeElement;
    if (active === null || active === document.body) nameRef.current?.focus();
  }, [shownId]);

  if (agent === undefined || state === null) return null;

  const urgent = attention.find((a) => a.agentId === agent.id && a.level === "needs_you");
  const needsYou = urgent !== undefined;
  const recorded = state.activity[agent.id];
  // A heuristic activity is a guess (constitution IV), so the header says so.
  const status = needsYou
    ? urgent.heuristic
      ? "Possibly needs you"
      : "Needs you"
    : recorded?.heuristic === true
      ? `Possibly ${activityText(recorded.activity).toLowerCase()}`
      : activityText(recorded?.activity ?? "unknown");
  const note = breakTime ? breakNote(status, onBreak?.has(agent.id) === true) : null;
  const elapsed = elapsedMs(agent, nowMs);
  const file = currentFile(agent.id, state.toolCalls);
  const crumbs = familyPath(agent.id, agents, teams);
  const tabs = visibleTabs(agent.id, agents, teams);
  const active = tabs.includes(chosen) ? chosen : "live";

  return (
    <InteractiveRegion
      className={styles.panel}
      data-testid="agent-panel"
      data-agent-id={agent.id}
      data-kind={agent.kind}
      data-readonly={mode === "history" ? "true" : undefined}
    >
      {crumbs.length < 2 ? null : (
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
                  onPress={() => {
                    crumbPressed.current = true;
                    select(id);
                  }}
                >
                  {nameOf(member)}
                </Button>
              </Fragment>
            );
          })}
        </nav>
      )}
      <header className={styles.header}>
        <h2 ref={nameRef} tabIndex={-1} className={styles.name} data-testid="agent-panel-name">
          {nameOf(agent)}
        </h2>
        <p className={styles.factsLine}>
          <span className={styles.factType} data-testid="agent-panel-type">
            {agent.role ?? KIND_LABEL[agent.kind]}
          </span>
          <span
            className={styles.status}
            data-testid="agent-panel-status"
            data-urgent={needsYou ? "true" : undefined}
          >
            {status}
          </span>
          {note === null ? null : <span data-testid="agent-panel-on-break">{note}</span>}
          {elapsed === null ? null : (
            <span data-testid="agent-panel-elapsed">{formatElapsed(elapsed)}</span>
          )}
        </p>
        {costView === undefined ? null : <AgentCost view={costView} className={styles.facts} />}
        {file === null ? null : (
          <p
            className={styles.file}
            data-testid="agent-panel-file"
            title={displayPath(file, { privacy: privacyMode })}
          >
            {displayPath(file, { privacy: privacyMode })}
          </p>
        )}
      </header>
      <HowDidWeGetHere agentId={agent.id} mode={mode} store={store} />
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
          {renderTab !== undefined ? (
            renderTab(active, agent.id)
          ) : active === "live" && mode === "live" ? (
            <ConnectedLiveTab
              agentId={agent.id}
              store={store}
              select={select}
              {...(card?.agentId === agent.id ? { focusCall: card.toolCallId } : {})}
              onFocusedCall={() => setCard(null)}
            />
          ) : active === "live" ? (
            <p>Live cards are not available for this history view.</p>
          ) : active === "files" && mode === "live" ? (
            <ConnectedFilesTab agentId={agent.id} />
          ) : active === "files" ? (
            <p>Files are not available for this history view.</p>
          ) : active === "crew" ? (
            <CrewTab
              parentId={agent.id}
              agents={state.agents}
              activity={state.activity}
              results={results}
              nowMs={nowMs}
              teams={teams}
              onSelect={select}
              onHover={(id) => highlightStore.hover(id)}
            />
          ) : null}
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
