import { expect } from "vitest";
import { storedEnvelopeSchema } from "../../../../../packages/protocol/src/index.ts";
import { initialState, reduce } from "../../../src/data/domain.ts";
import { SESSION_HEADER } from "../../../src/pairing/pair.ts";
import { FakeEngine, frame, PROJECT, SECRET } from "../../data/fake-engine.ts";
import { stateAt, timelineEngine } from "./timeline-fixture.ts";

export { PROJECT, SECRET };
export const AGENT = "recorded-agent";
export const PREVIEW = "Synthetic recorded preview: read recorded.ts";
export const EXACT = "Synthetic live exact input: CURRENT_ONLY.ts";

/** Synthetic permission recording, not imported/raw telemetry or a claim of real agent work. */
export function cardsRecording(resolution: "expired" | "answered_elsewhere" = "expired") {
  const specs = [
    {
      type: "agent.registered",
      payload: {
        sourceAgentId: "synthetic-source",
        displayName: "Recorded Ada",
        role: "reviewer",
        kind: "session",
      },
    },
    { type: "agent.connected", payload: {} },
    {
      type: "request.opened",
      sourceId: "taskville:bridge",
      payload: {
        requestId: "recorded-request",
        kind: "permission",
        toolName: "Read",
        inputPreview: PREVIEW,
      },
    },
    resolution === "expired"
      ? {
          type: "request.expired",
          sourceId: "taskville:engine",
          payload: { requestId: "recorded-request" },
        }
      : {
          type: "request.resolved",
          sourceId: "taskville:engine",
          payload: { requestId: "recorded-request", resolution },
        },
  ];
  return specs.map((spec, i) => {
    const at = new Date(Date.parse("2026-10-31T12:00:00Z") + i * 1000).toISOString();
    return storedEnvelopeSchema.parse({
      schemaVersion: 1,
      projectId: PROJECT,
      sourceId: "synthetic-cards",
      sourceEventId: `cards-${i + 1}`,
      agentId: AGENT,
      sessionId: "recorded-session",
      evidenceIds: [],
      provenance: "live",
      late: false,
      eventId: `00000000-0000-4000-8002-${String(i + 1).padStart(12, "0")}`,
      occurredAt: at,
      receivedAt: at,
      ingestSequence: i + 1,
      ...spec,
    });
  });
}

export function cardsEngine(resolution?: "expired" | "answered_elsewhere") {
  const log = cardsRecording(resolution);
  const current = [
    ...log,
    storedEnvelopeSchema.parse({
      ...log[0],
      ingestSequence: 5,
      sourceEventId: "current-name",
      eventId: "00000000-0000-4000-8002-000000000005",
      payload: {
        sourceAgentId: "synthetic-source",
        displayName: "Current Ada",
        role: "live developer",
        kind: "session",
      },
    }),
    storedEnvelopeSchema.parse({
      ...log[2],
      ingestSequence: 6,
      sourceEventId: "current-request",
      eventId: "00000000-0000-4000-8002-000000000006",
      sessionId: "current-session",
      payload: {
        requestId: "current-request",
        kind: "permission",
        toolName: "Write",
        inputPreview: "Synthetic current preview",
      },
    }),
  ];
  const live = new FakeEngine(current);
  const timeline = timelineEngine(log);
  const calls: Array<{ url: URL; method: string }> = [];
  const streams: ReadableStreamDefaultController<Uint8Array>[] = [];
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
          streams.push(controller);
          controller.enqueue(
            new TextEncoder().encode(
              frame("snapshot", { projects: [], computedAt: log[3].receivedAt }),
            ),
          );
        },
      });
      init?.signal?.addEventListener("abort", () => {
        try {
          streams.at(-1)?.close();
        } catch {
          /* already closed */
        }
      });
      return new Response(body, { headers: { "Content-Type": "text/event-stream" } });
    }
    if (url.pathname === "/v1/requests/current-request/input") {
      expect(url.searchParams.get("projectId")).toBe(PROJECT);
      return Response.json({
        requestId: "current-request",
        projectId: PROJECT,
        sessionId: "current-session",
        toolName: "Write",
        toolInput: { file_path: EXACT },
      });
    }
    return live.fetch(input, init);
  };
  return {
    log,
    live,
    calls,
    fetcher,
    stateAt: (head: number) => stateAt(head, log),
    current: current.reduce(reduce, initialState(PROJECT)),
  };
}
