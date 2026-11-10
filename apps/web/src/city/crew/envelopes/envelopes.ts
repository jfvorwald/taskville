import type { Agent, StoredEnvelope } from "../../../data/domain.ts";

type TeamMessageKind = Extract<StoredEnvelope, { type: "team.message" }>["payload"]["kind"];

// M5.04: the pure side of teammate message envelopes (ARCHITECTURE 2.9). A team.message event
// becomes one envelope that flies from the sender to the recipient on the store clock.

/** Flight time from sender to recipient, in store-clock milliseconds. */
export const ENVELOPE_FLIGHT_MS = 2000;

export interface Envelope {
  /** The `eventId` of the team.message event. */
  id: string;
  fromAgentId: string;
  /** The agent whose display name or source id equals `to`, else null. */
  toAgentId: string | null;
  /** The recipient as the sender wrote it. */
  to: string;
  kind: TeamMessageKind;
  summary?: string;
  /** The SendMessage tool-call id, when the event carried one. */
  toolCallId?: string;
  sentAt: number;
}

type Agents = Readonly<Record<string, Agent>>;

/**
 * The one agent the sender means by `to`: within the sender's team and source when it has them.
 * Zero matches, or several, leave the recipient unresolved rather than guessing.
 */
function resolve(to: string, from: string, agents: Agents): string | null {
  const wanted = to.toLowerCase();
  const sender = agents[from];
  const matches = Object.values(agents).filter(
    (agent) =>
      (sender === undefined ||
        (agent.sourceId === sender.sourceId &&
          (sender.teamId === undefined || agent.teamId === sender.teamId))) &&
      (agent.sourceAgentId === to || agent.displayName?.toLowerCase() === wanted),
  );
  return matches.length === 1 ? (matches[0]?.id ?? null) : null;
}

export function envelopeFor(
  event: StoredEnvelope,
  agents: Agents,
  sentAt: number,
): Envelope | null {
  if (event.type !== "team.message" || event.agentId === undefined) return null;
  const { to, kind, summary, toolCallId } = event.payload;
  return {
    id: event.eventId,
    fromAgentId: event.agentId,
    toAgentId: resolve(to, event.agentId, agents),
    to,
    kind,
    ...(summary === undefined ? {} : { summary }),
    ...(toolCallId === undefined ? {} : { toolCallId }),
    sentAt,
  };
}

/** Hover text: "<from> to <to>", with ": <summary>" when the message has one. */
export function envelopeLabel(envelope: Envelope, agents: Agents): string {
  const from = agents[envelope.fromAgentId]?.displayName ?? envelope.fromAgentId;
  const to =
    envelope.toAgentId === null
      ? envelope.to
      : (agents[envelope.toAgentId]?.displayName ?? envelope.toAgentId);
  const head = `${from} to ${to}`;
  return envelope.summary === undefined || envelope.summary === ""
    ? head
    : `${head}: ${envelope.summary}`;
}

export interface EnvelopeLog {
  observe(event: StoredEnvelope, agents: Agents, sentAt: number): Envelope | null;
  live(now: number): readonly Envelope[];
}

export function createEnvelopeLog(): EnvelopeLog {
  const seen = new Set<string>();
  let envelopes: Envelope[] = [];
  return {
    observe(event, agents, sentAt) {
      if (seen.has(event.eventId)) return null;
      const made = envelopeFor(event, agents, sentAt);
      if (made === null) return null;
      seen.add(event.eventId);
      envelopes.push(made);
      return made;
    },
    live(now) {
      envelopes = envelopes.filter((e) => now - e.sentAt < ENVELOPE_FLIGHT_MS);
      return envelopes;
    },
  };
}
