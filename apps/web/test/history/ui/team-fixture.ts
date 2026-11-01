import { expect } from "vitest";
import { storedEnvelopeSchema } from "../../../../../packages/protocol/src/index.ts";
import { initialState, reduce } from "../../../src/data/domain.ts";
import { SESSION_HEADER } from "../../../src/pairing/pair.ts";
import { FakeEngine, frame, PROJECT, SECRET } from "../../data/fake-engine.ts";
import { stateAt, timelineEngine } from "./timeline-fixture.ts";

export { PROJECT, SECRET };
export const TEAM = "claude-code:team:replay";
export const EARLY = "Recorded early task";
export const LATE = "Recorded late task";
export const LIVE_ONLY = "Live only task after the recording";

/** Synthetic team recording: four events; the second task is created at the head (event 4). */
export function teamRecording() {
  const specs: Array<Record<string, unknown>> = [
    {
      type: "agent.registered",
      agentId: "lead",
      payload: {
        sourceAgentId: "lead-source",
        displayName: "Team lead",
        role: "lead",
        kind: "lead",
        teamId: TEAM,
      },
    },
    { type: "team.started", agentId: "lead", payload: { teamId: TEAM, leadAgentId: "lead" } },
    {
      type: "task.created",
      taskId: "claude-code:task:replay:1",
      payload: { title: EARLY },
    },
    {
      type: "task.created",
      taskId: "claude-code:task:replay:2",
      payload: { title: LATE },
    },
  ];
  return specs.map((spec, i) => {
    const at = new Date(Date.parse("2026-10-31T12:00:00Z") + i * 1000).toISOString();
    return storedEnvelopeSchema.parse({
      schemaVersion: 1,
      projectId: PROJECT,
      sourceId: "claude-code",
      sourceEventId: `team-${i + 1}`,
      evidenceIds: [],
      provenance: "live",
      late: false,
      eventId: `00000000-0000-4000-8003-${String(i + 1).padStart(12, "0")}`,
      occurredAt: at,
      receivedAt: at,
      ingestSequence: i + 1,
      ...spec,
    });
  });
}

/** The live store runs ahead of the recording by one task the recording never contains. */
export function teamEngine() {
  const log = teamRecording();
  const current = [
    ...log,
    storedEnvelopeSchema.parse({
      ...log[3],
      ingestSequence: 5,
      sourceEventId: "team-live-only",
      eventId: "00000000-0000-4000-8003-000000000005",
      taskId: "claude-code:task:replay:3",
      payload: { title: LIVE_ONLY },
    }),
  ];
  const live = new FakeEngine(current);
  const timeline = timelineEngine(log);
  const calls: Array<{ url: URL; method: string }> = [];
  const fetcher: typeof fetch = async (input, init) => {
    const url = new URL(String(input), location.origin);
    const method = init?.method ?? "GET";
    calls.push({ url, method });
    expect(new Headers(init?.headers).get(SESSION_HEADER)).toBe(SECRET);
    if (method !== "GET") return new Response(null, { status: 405 });
    if (url.pathname.includes("/timelines")) return timeline.fetcher(input, init);
    if (url.pathname === "/v1/attention/events") {
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(
            new TextEncoder().encode(
              frame("snapshot", { projects: [], computedAt: log[3].receivedAt }),
            ),
          );
        },
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    return live.fetch(input, init);
  };
  return {
    log,
    calls,
    fetcher,
    stateAt: (head: number) => stateAt(head, log),
    current: current.reduce(reduce, initialState(PROJECT)),
  };
}
