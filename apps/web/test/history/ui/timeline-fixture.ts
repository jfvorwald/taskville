import { expect } from "vitest";
import {
  idSchema,
  positiveIntSchema,
  type StoredEnvelope,
  storedEnvelopeSchema,
  timestampSchema,
} from "../../../../../packages/protocol/src/index.ts";
import {
  attention,
  initialState,
  projectStateHash,
  REDUCER_VERSION,
  reduce,
  snapshotResponseSchema,
} from "../../../src/data/domain.ts";
import { SESSION_HEADER } from "../../../src/pairing/pair.ts";
import { PROJECT, SECRET } from "../../data/fake-engine.ts";

export const TIMELINE = `live:${PROJECT}`;
const specs = [
  {
    type: "agent.registered",
    agentId: "a1",
    payload: { sourceAgentId: "source-a1", displayName: "Ada", role: "dev", kind: "session" },
  },
  {
    type: "agent.registered",
    agentId: "a2",
    payload: { sourceAgentId: "source-a2", displayName: "Bea", role: "dev", kind: "session" },
  },
  { type: "task.created", agentId: "a2", taskId: "t1", payload: { title: "Recorded task" } },
  {
    type: "request.opened",
    agentId: "a1",
    payload: { requestId: "r1", kind: "permission", toolName: "Read" },
  },
  { type: "task.status_changed", agentId: "a2", taskId: "t1", payload: { status: "completed" } },
  {
    type: "git.commit",
    agentId: "a1",
    payload: { repo: "recording", sha: "a".repeat(40), parents: [], subject: "Recorded commit" },
  },
  {
    type: "request.opened",
    agentId: "a2",
    payload: { requestId: "r2", kind: "permission", toolName: "Read" },
  },
  // A source that recorded no agent must not acquire one from a title or nearby event.
  {
    type: "git.commit",
    payload: {
      repo: "recording",
      sha: "b".repeat(40),
      parents: [],
      subject: "Ada did not record ownership",
    },
  },
];

export const LOG = specs.map((spec, index) => {
  const receivedAt = `2026-10-${index < 4 ? "30" : "31"}T12:0${index % 4}:00Z`;
  return storedEnvelopeSchema.parse({
    ...spec,
    schemaVersion: 1,
    projectId: PROJECT,
    sourceId: "timeline-test",
    sourceEventId: `event-${index + 1}`,
    eventId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`,
    ingestSequence: index + 1,
    receivedAt,
    // Deliberately different: day markers describe receipt, not occurrence.
    occurredAt: "2026-10-29T01:00:00Z",
    evidenceIds: [],
    provenance: "live",
    late: false,
  });
});

export const stateAt = (sequence: number, log: readonly StoredEnvelope[] = LOG) =>
  log.slice(0, sequence).reduce(reduce, initialState(PROJECT));

// The timeline routes have no exported response schemas. Validate their actual wire shape
// here using protocol primitives/envelopes and the real snapshot schema, before serving it.
export function timelineEngine(log: readonly StoredEnvelope[] = LOG) {
  const requests: URL[] = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    requests.push(url);
    expect(init?.method ?? "GET").toBe("GET");
    expect(new Headers(init?.headers).get(SESSION_HEADER)).toBe(SECRET);
    const path = decodeURIComponent(url.pathname);
    if (path === `/v1/projects/${PROJECT}/timelines`) {
      const timeline = {
        id: TIMELINE,
        kind: "live",
        projectId: PROJECT,
        firstSequence: 1,
        lastSequence: log.length,
        eventCount: log.length,
        firstAt: log[0].receivedAt,
        lastAt: log.at(-1)?.receivedAt,
      };
      idSchema.parse(timeline.id);
      idSchema.parse(timeline.projectId);
      expect(timeline.kind).toBe("live");
      for (const value of [timeline.firstSequence, timeline.lastSequence, timeline.eventCount])
        positiveIntSchema.parse(value);
      timestampSchema.parse(timeline.firstAt);
      timestampSchema.parse(timeline.lastAt);
      return Response.json({ projectId: idSchema.parse(PROJECT), timelines: [timeline] });
    }
    const position = (raw: string) =>
      /^\d+$/.test(raw)
        ? Math.min(Number(raw), log.length)
        : (log.filter((event) => Date.parse(event.receivedAt) <= Date.parse(raw)).at(-1)
            ?.ingestSequence ?? 0);
    if (path === `/v1/timelines/${TIMELINE}/events`) {
      // This concise recording fits one real page. Existing 202-event controls own page walks.
      expect(url.searchParams.has("cursor")).toBe(false);
      const fromRaw = url.searchParams.get("from");
      const from =
        fromRaw === null
          ? 1
          : /^\d+$/.test(fromRaw)
            ? Math.max(1, Number(fromRaw))
            : (log.find((event) => Date.parse(event.receivedAt) >= Date.parse(fromRaw))
                ?.ingestSequence ?? log.length + 1);
      const to = position(url.searchParams.get("to") ?? String(log.length));
      const events = log
        .filter((event) => event.ingestSequence >= from && event.ingestSequence <= to)
        .slice(0, Number(url.searchParams.get("limit") ?? 200));
      expect(events.length).toBeLessThanOrEqual(200);
      return Response.json({
        timelineId: idSchema.parse(TIMELINE),
        events: events.map((event) => storedEnvelopeSchema.parse(event)),
        nextCursor: null,
      });
    }
    expect(path).toBe(`/v1/timelines/${TIMELINE}/state`);
    const raw = url.searchParams.get("at");
    expect(raw).not.toBeNull();
    const state = stateAt(position(raw ?? ""), log);
    const snapshot = snapshotResponseSchema.parse({
      projectId: PROJECT,
      cursor: state.head,
      reducerVersion: REDUCER_VERSION,
      stateHash: projectStateHash(state),
      state,
      attention: attention(state, Date.parse(log[state.head - 1]?.receivedAt ?? log[0].receivedAt)),
      computedAt: "2026-11-01T12:00:00Z",
    });
    // Unlike /snapshot, the actual timeline state response has no projectId field.
    const { projectId: _projectId, ...wire } = snapshot;
    return Response.json({ timelineId: idSchema.parse(TIMELINE), at: state.head, ...wire });
  };
  return { fetcher, requests };
}

/** Synthetic recording that exercises real reducer retention, not a manually pruned snapshot. */
export function retiredAgentRecording(): StoredEnvelope[] {
  const specs: Array<Record<string, unknown>> = [
    {
      type: "agent.registered",
      agentId: "retired",
      payload: {
        sourceAgentId: "retired-source",
        displayName: "Retired reviewer",
        role: "reviewer",
        kind: "session",
      },
    },
    {
      type: "task.created",
      agentId: "retired",
      taskId: "retired-task",
      payload: { title: "Recorded earlier task" },
    },
    {
      type: "task.status_changed",
      agentId: "retired",
      taskId: "retired-task",
      payload: { status: "completed" },
    },
    {
      type: "git.commit",
      agentId: "retired",
      payload: {
        repo: "recording",
        sha: "c".repeat(40),
        parents: [],
        subject: "Earlier recorded work",
      },
    },
    { type: "agent.finished", agentId: "retired", payload: { outcome: "completed" } },
  ];
  for (let index = 0; index < 50; index++) {
    const agentId = `newer-${index}`;
    specs.push({
      type: "agent.registered",
      agentId,
      payload: {
        sourceAgentId: agentId,
        displayName: `Newer agent ${index}`,
        role: "reviewer",
        kind: "session",
      },
    });
    specs.push({ type: "agent.finished", agentId, payload: { outcome: "completed" } });
  }
  return specs.map((spec, index) => {
    const timestamp = new Date(Date.parse("2026-10-31T12:00:00Z") + index * 1000).toISOString();
    return storedEnvelopeSchema.parse({
      ...spec,
      schemaVersion: 1,
      projectId: PROJECT,
      sourceId: "retention-fixture",
      sourceEventId: `retention-${index + 1}`,
      eventId: `00000000-0000-4000-8001-${String(index + 1).padStart(12, "0")}`,
      ingestSequence: index + 1,
      receivedAt: timestamp,
      occurredAt: timestamp,
      evidenceIds: [],
      provenance: "live",
      late: false,
    });
  });
}
