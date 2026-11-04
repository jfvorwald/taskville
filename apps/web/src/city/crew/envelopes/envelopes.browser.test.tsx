import { describe, expect, it } from "vitest";
import inProcess from "../../../../../../packages/adapters/test/claude-code/crew/golden/team-in-process.json";
import splitPane from "../../../../../../packages/adapters/test/claude-code/crew/golden/team-split-pane.json";
import {
  type StoredEnvelope,
  storedEnvelopeSchemas,
} from "../../../../../../packages/protocol/src/index.ts";
import type { Agent } from "../../../data/domain.ts";
import { AT, message, PROJECT, stored } from "./envelopeFixtures.ts";
import {
  createEnvelopeLog,
  ENVELOPE_FLIGHT_MS,
  type Envelope,
  envelopeFor,
  envelopeLabel,
} from "./envelopes.ts";

// M5.04 red: the pure event-to-envelope mapping. This runs under the browser config only because
// apps/web's node project includes just test/**; it touches no DOM.

const agent = (id: string, displayName: string, extra: Partial<Agent> = {}): Agent =>
  ({
    id,
    sourceId: "claude-code",
    sourceAgentId: `src-${id}`,
    displayName,
    kind: "teammate",
    registered: true,
    connection: "connected",
    firstSeenAt: AT,
    lastSeenAt: AT,
    toolCallCount: 0,
    consecutiveToolFailures: 0,
    ...extra,
  }) as Agent;

const AGENTS = {
  pip: agent("pip", "Pip"),
  bo: agent("bo", "Bo"),
  lead: agent("lead", "Lead", { kind: "lead" }),
};

type Golden = { events: { type: string; agentId: string; payload: Record<string, unknown> }[] }[];

/** The golden holds input-form payloads; ingest stores `reason` as `{ text, masked, truncated }`. */
function storedForm(payload: Record<string, unknown>): Record<string, unknown> {
  const { reason } = payload;
  if (typeof reason !== "string") return payload;
  return { ...payload, reason: { text: reason, masked: false, truncated: false } };
}

/** Every event of a recorded S-2 stream, as stored envelopes in receive order. */
function recorded(golden: Golden): StoredEnvelope[] {
  let seq = 0;
  return golden.flatMap((hook) =>
    hook.events.map((e) => {
      seq++;
      return storedEnvelopeSchemas[e.type as StoredEnvelope["type"]].parse({
        schemaVersion: 1,
        projectId: PROJECT,
        sourceId: "claude-code",
        sourceEventId: `golden-${seq}`,
        eventId: `00000000-0000-4000-9000-${seq.toString(16).padStart(12, "0")}`,
        type: e.type,
        payload: storedForm(e.payload),
        occurredAt: AT,
        receivedAt: AT,
        ingestSequence: seq,
        evidenceIds: [],
        provenance: "live",
        late: false,
        agentId: e.agentId,
      }) as StoredEnvelope;
    }),
  );
}

describe("envelopeFor", () => {
  it("makes an envelope from a team.message, from the sender to the named recipient", () => {
    const event = message("pip", "bo", "hi bo");
    expect(envelopeFor(event, AGENTS, 1000)).toEqual({
      id: event.eventId,
      fromAgentId: "pip",
      toAgentId: "bo",
      to: "bo",
      kind: "message",
      summary: "hi bo",
      sentAt: 1000,
    });
  });

  it("resolves the recipient by display name, ignoring case, and by source agent id", () => {
    expect(envelopeFor(message("pip", "BO"), AGENTS, 0)?.toAgentId).toBe("bo");
    expect(envelopeFor(message("pip", "src-lead"), AGENTS, 0)?.toAgentId).toBe("lead");
  });

  it("keeps an unresolved recipient as written, with no agent id", () => {
    const made = envelopeFor(message("pip", "team-lead"), AGENTS, 0);
    expect(made?.toAgentId).toBeNull();
    expect(made?.to).toBe("team-lead");
  });

  it("makes nothing for any other event type", () => {
    expect(
      envelopeFor(stored("activity.started", "pip", { activity: "idle" }), AGENTS, 0),
    ).toBeNull();
    expect(envelopeFor(stored("team.ended", "pip", { teamId: "t" }), AGENTS, 0)).toBeNull();
  });
});

describe("envelopeLabel", () => {
  it("says who wrote to whom, with the summary when there is one", () => {
    const withSummary = envelopeFor(message("pip", "bo", "hi bo"), AGENTS, 0);
    const bare = envelopeFor(message("pip", "bo"), AGENTS, 0);
    expect(envelopeLabel(withSummary as Envelope, AGENTS)).toBe("Pip to Bo: hi bo");
    expect(envelopeLabel(bare as Envelope, AGENTS)).toBe("Pip to Bo");
  });

  it("falls back to the raw recipient name when it is not a known agent", () => {
    const made = envelopeFor(message("pip", "team-lead"), AGENTS, 0);
    expect(envelopeLabel(made as Envelope, AGENTS)).toBe("Pip to team-lead");
  });
});

describe("createEnvelopeLog", () => {
  it("creates one envelope per message event and none for other events", () => {
    const log = createEnvelopeLog();
    const events = [
      message("pip", "bo"),
      stored("activity.started", "pip", { activity: "idle" }),
      message("bo", "pip"),
      message("pip", "bo"),
    ];
    const made = events.map((e) => log.observe(e, AGENTS, 0));
    expect(made.filter((m) => m !== null)).toHaveLength(3);
    expect(made[1]).toBeNull();
    expect(log.live(0).map((e) => e.id)).toEqual(
      [events[0], events[2], events[3]].map((e) => e?.eventId),
    );
  });

  it("never makes a second envelope for an event it has already seen", () => {
    const log = createEnvelopeLog();
    const event = message("pip", "bo");
    expect(log.observe(event, AGENTS, 0)).not.toBeNull();
    expect(log.observe(event, AGENTS, 50)).toBeNull();
    expect(log.live(50)).toHaveLength(1);
  });

  it("lists an envelope only while it is in flight", () => {
    const log = createEnvelopeLog();
    log.observe(message("pip", "bo"), AGENTS, 1000);
    expect(log.live(1000 + ENVELOPE_FLIGHT_MS - 1)).toHaveLength(1);
    expect(log.live(1000 + ENVELOPE_FLIGHT_MS)).toHaveLength(0);
  });

  it("makes one envelope per team.message in the recorded in-process team stream", () => {
    const events = recorded(inProcess as Golden);
    const expected = events.filter((e) => e.type === "team.message");
    expect(expected).toHaveLength(6);
    const log = createEnvelopeLog();
    for (const e of events) log.observe(e, {}, 0);
    expect(log.live(0).map((e) => e.id)).toEqual(expected.map((e) => e.eventId));
  });

  it("makes one envelope per team.message in the recorded split-pane team stream", () => {
    const events = recorded(splitPane as Golden);
    const expected = events.filter((e) => e.type === "team.message");
    expect(expected).toHaveLength(7);
    const log = createEnvelopeLog();
    for (const e of events) log.observe(e, {}, 0);
    expect(log.live(0)).toHaveLength(7);
  });
});
