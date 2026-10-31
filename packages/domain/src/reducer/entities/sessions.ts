import { getOwn, omit, optional, put } from "./maps.ts";
import { compareTimestamps } from "./time.ts";
import type {
  ActivityEntry,
  AgentActivity,
  DomainEvent,
  EntitiesState,
  Session,
  TestResultEvidence,
} from "./types.ts";

// Sessions and activity. An agent may have several open sessions; its primary activity is that
// of the most recently started open one (data-model.md). A session belongs to the agent that
// first reported it, and no other agent's events change it: in-process teammates share the
// lead's session_id (S-2), so their activity is the teammate's own, not the lead's session's.

const unknownActivity = (since: string): ActivityEntry => ({
  activity: "unknown",
  heuristic: false,
  since,
});

/** The session if `agentId` owns it; otherwise undefined. */
function ownSession(s: EntitiesState, agentId: string, sessionId: string): Session | undefined {
  const session = getOwn(s.sessions, sessionId);
  return session?.agentId === agentId ? session : undefined;
}

/** The session, created as open (with no start time) if this is the first we hear of it. */
function ensureSession(
  s: EntitiesState,
  e: DomainEvent,
  agentId: string,
  sessionId: string,
): EntitiesState {
  if (Object.hasOwn(s.sessions, sessionId)) return s;
  const session: Session = {
    id: sessionId,
    agentId,
    sourceId: e.sourceId,
    provenance: e.provenance,
    firstSeenAt: e.occurredAt,
    startSeq: e.ingestSequence,
    activity: unknownActivity(e.occurredAt),
  };
  return { ...s, sessions: put(s.sessions, sessionId, session) };
}

export function applySessionStarted(
  s: EntitiesState,
  e: DomainEvent & { type: "session.started" },
  agentId: string,
  sessionId: string,
): EntitiesState {
  const existing = getOwn(s.sessions, sessionId);
  if (existing !== undefined && existing.agentId !== agentId) return s;
  const workingDirectory = optional("workingDirectory", e.payload.workingDirectory);
  // A start older than the recorded end arrived late (async hooks race, S-2): it fills in the
  // start time but does not reopen the session.
  const reopens =
    existing === undefined ||
    (existing.endedAt !== undefined && compareTimestamps(e.occurredAt, existing.endedAt) > 0);
  let session: Session;
  if (reopens) {
    // New, or reopened after it ended: it becomes the most recently started session.
    session = {
      ...(existing === undefined ? {} : omit(existing, ["endedAt"])),
      id: sessionId,
      agentId,
      sourceId: existing?.sourceId ?? e.sourceId,
      provenance: existing?.provenance ?? e.provenance,
      firstSeenAt: existing?.firstSeenAt ?? e.occurredAt,
      startedAt: e.occurredAt,
      startSeq: e.ingestSequence,
      ...workingDirectory,
      activity: unknownActivity(e.occurredAt),
    };
  } else {
    // Already open, or a late start for an ended session: fill in what was missing.
    session = {
      ...existing,
      startedAt: existing.startedAt ?? e.occurredAt,
      ...workingDirectory,
    };
  }
  return { ...s, sessions: put(s.sessions, sessionId, session) };
}

export function applySessionEnded(
  s: EntitiesState,
  e: DomainEvent,
  agentId: string,
  sessionId: string,
): EntitiesState {
  const ensured = ensureSession(s, e, agentId, sessionId);
  const session = ownSession(ensured, agentId, sessionId);
  if (session === undefined || session.endedAt !== undefined) return ensured;
  return {
    ...ensured,
    sessions: put(ensured.sessions, sessionId, { ...session, endedAt: e.occurredAt }),
  };
}

/** Any other session event: proves the session exists, so record it if new. */
export const applySessionSeen = ensureSession;

/**
 * The agent's most recently started open session, by start time (`startedAt`, or `firstSeenAt`
 * for a session whose start was never reported), then by the order it was opened, then by ID.
 * Start time, not arrival order, because a start can arrive after other events (S-2).
 */
function primarySession(s: EntitiesState, agentId: string): Session | undefined {
  let primary: Session | undefined;
  for (const session of Object.values(s.sessions)) {
    if (session.agentId !== agentId || session.endedAt !== undefined) continue;
    if (primary === undefined || startsAfter(session, primary)) primary = session;
  }
  return primary;
}

function startsAfter(a: Session, b: Session): boolean {
  const byTime = compareTimestamps(a.startedAt ?? a.firstSeenAt, b.startedAt ?? b.firstSeenAt);
  if (byTime !== 0) return byTime > 0;
  if (a.startSeq !== b.startSeq) return a.startSeq > b.startSeq;
  return a.id > b.id;
}

/**
 * Sets an activity for `agentId`. A named session the agent owns gets it; a named session no one
 * has reported yet is recorded as the agent's. A session named by an event but owned by another
 * agent is never written; the activity goes to the agent itself. With no session named, it goes
 * to the agent's primary session, or, with no open session, to the agent.
 */
export function setActivity(
  s: EntitiesState,
  e: DomainEvent,
  agentId: string,
  sessionId: string | undefined,
  entry: ActivityEntry,
): EntitiesState {
  let state = s;
  let target: Session | undefined;
  if (sessionId === undefined) {
    target = primarySession(state, agentId);
  } else {
    state = ensureSession(state, e, agentId, sessionId);
    target = ownSession(state, agentId, sessionId);
  }
  if (target !== undefined) {
    return { ...state, sessions: put(state.sessions, target.id, { ...target, activity: entry }) };
  }
  const current = getOwn(state.activity, agentId);
  if (current === undefined) return state;
  return { ...state, activity: put(state.activity, agentId, { ...viewBase(current), ...entry }) };
}

export function setLatestEvidence(
  s: EntitiesState,
  agentId: string,
  latestEvidence: TestResultEvidence,
): EntitiesState {
  const current = getOwn(s.activity, agentId);
  if (current === undefined) return s;
  return { ...s, activity: put(s.activity, agentId, { ...current, latestEvidence }) };
}

/** The fields of an AgentActivity that do not come from an activity entry. */
const viewBase = (current: AgentActivity) => ({
  agentId: current.agentId,
  ...optional("latestEvidence", current.latestEvidence),
  openSessionCount: current.openSessionCount,
});

/**
 * Recomputes an agent's primary activity from its sessions. When the last open session ends,
 * the agent becomes idle as of that event; with no session at all, the agent-level entry stays.
 */
export function refreshActivity(s: EntitiesState, e: DomainEvent, agentId: string): EntitiesState {
  const current = getOwn(s.activity, agentId);
  if (current === undefined) return s;
  let openSessionCount = 0;
  for (const session of Object.values(s.sessions)) {
    if (session.agentId === agentId && session.endedAt === undefined) openSessionCount += 1;
  }
  const primary = primarySession(s, agentId);
  const base = { ...viewBase(current), openSessionCount };
  let next: AgentActivity;
  if (primary !== undefined) {
    next = { ...base, sessionId: primary.id, ...primary.activity };
  } else if (current.sessionId !== undefined) {
    next = { ...base, activity: "idle", heuristic: false, since: e.occurredAt };
  } else {
    next = { ...current, openSessionCount };
  }
  return { ...s, activity: put(s.activity, agentId, next) };
}
