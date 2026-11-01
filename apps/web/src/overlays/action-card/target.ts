import { useRef } from "react";
import type { Attention } from "../../data/domain.ts";
import { useData } from "../../data/react.ts";
import type { DataStore } from "../../data/store.ts";

/** The parts of a recorded request the card reads. */
export interface RequestLike {
  sessionId?: string | undefined;
  toolName?: string | undefined;
  inputPreview?: string | undefined;
  reason?: { text: string } | undefined;
  answerable: boolean;
  state: string;
}

type Requests = Readonly<Record<string, RequestLike>>;
type Agents = Readonly<Record<string, { displayName?: string | undefined }>>;

/** Which request the card is about, and what it knows of it without asking the bridge. */
export interface CardTarget {
  agentId: string;
  agentName: string;
  requestId: string;
  sessionId: string | undefined;
  toolName: string | undefined;
  inputPreview: string | undefined;
  reason: string | undefined;
  sinceMs: number;
  answerable: boolean;
  requestState: string;
}

/**
 * The card opens for the selected agent when it has a `needs_you` record that points at a
 * request. `attention` is most urgent first, so the first match is the one shown. A request that
 * state does not hold is never answerable: a decision is not offered on a guess.
 */
export function cardTarget(args: {
  selectedId: string | null;
  attention: readonly Attention[];
  requests: Requests;
  agents: Agents;
}): CardTarget | null {
  const { selectedId, attention, requests, agents } = args;
  if (selectedId === null) return null;
  const record = attention.find(
    (r) => r.agentId === selectedId && r.level === "needs_you" && r.requestId !== undefined,
  );
  if (record?.requestId === undefined) return null;
  const request = requests[record.requestId];
  return {
    agentId: selectedId,
    agentName: agents[selectedId]?.displayName ?? selectedId,
    requestId: record.requestId,
    sessionId: request?.sessionId,
    toolName: request?.toolName,
    inputPreview: request?.inputPreview,
    reason: request?.reason?.text,
    sinceMs: Date.parse(record.since),
    answerable: request?.answerable === true,
    requestState: request?.state ?? "open",
  };
}

/**
 * The card's target for the selected agent. When the request leaves attention (answered, expired)
 * the card stays up showing its final state until the selection changes, so a "Sent, unconfirmed"
 * is never taken away by the event that follows it.
 */
export function useCardTarget(store: DataStore, selectedId: string | null): CardTarget | null {
  const attention = useData((s) => s.attention, store);
  const requests = useData((s) => s.state?.requests, store) as Requests | undefined;
  const agents = useData((s) => s.state?.agents, store) as Agents | undefined;
  const kept = useRef<CardTarget | null>(null);
  const live = cardTarget({
    selectedId,
    attention,
    requests: requests ?? {},
    agents: agents ?? {},
  });
  if (live !== null) kept.current = live;
  else if (selectedId === null || kept.current?.agentId !== selectedId) kept.current = null;
  const held = kept.current;
  if (live !== null || held === null) return live;
  const state = requests?.[held.requestId]?.state;
  return state === undefined ? held : { ...held, requestState: state };
}
