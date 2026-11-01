import { expect } from "vitest";
import { storedEnvelopeSchema } from "../../../../../packages/protocol/src/index.ts";
import { initialState, reduce } from "../../../src/data/domain.ts";
import { SESSION_HEADER } from "../../../src/pairing/pair.ts";
import { FakeEngine, frame, PROJECT, SECRET } from "../../data/fake-engine.ts";
import { stateAt, timelineEngine } from "./timeline-fixture.ts";

export { PROJECT, SECRET };
export const ADA = "agent-ada";
export const BEA = "agent-bea";
/** Registered only in the live store, after the recording ended: the replay does not know it. */
export const LIVE_ONLY = "agent-live-only";

export interface Spec {
  type: "agent.registered" | "request.opened";
  agentId: string;
  /** Request events only. */
  requestId?: string;
  toolName?: string;
  preview?: string;
  late?: boolean;
}

/** Synthetic recording, one event per spec, one second apart. Not real agent telemetry. */
export function recording(specs: readonly Spec[], firstSequence = 1) {
  return specs.map((spec, i) => {
    const n = firstSequence + i;
    const iso = new Date(Date.parse("2026-10-31T12:00:00Z") + n * 1000).toISOString();
    const registered = spec.type === "agent.registered";
    return storedEnvelopeSchema.parse({
      schemaVersion: 1,
      projectId: PROJECT,
      sourceId: "synthetic-requests",
      sourceEventId: `requests-${n}`,
      agentId: spec.agentId,
      ...(registered ? {} : { sessionId: `session-${spec.requestId}` }),
      evidenceIds: [],
      provenance: "live",
      late: spec.late === true,
      eventId: `00000000-0000-4000-8004-${String(n).padStart(12, "0")}`,
      occurredAt: iso,
      receivedAt: iso,
      ingestSequence: n,
      type: spec.type,
      payload: registered
        ? {
            sourceAgentId: `source-${spec.agentId}`,
            displayName: spec.agentId === BEA ? "Recorded Bea" : "Recorded Ada",
            role: "reviewer",
            kind: "session",
          }
        : {
            requestId: spec.requestId,
            kind: "permission",
            toolName: spec.toolName ?? "Read",
            ...(spec.preview === undefined ? {} : { inputPreview: spec.preview }),
          },
    });
  });
}

/**
 * The recording is served as the timeline; the live store holds the same events plus, when asked,
 * one more agent the recording never contains. Any write is refused and recorded.
 */
export function requestsEngine(specs: readonly Spec[], liveOnlyAgent = false) {
  const log = recording(specs);
  const current = liveOnlyAgent
    ? [...log, ...recording([{ type: "agent.registered", agentId: LIVE_ONLY }], log.length + 1)]
    : log;
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
              frame("snapshot", { projects: [], computedAt: log.at(-1)?.receivedAt }),
            ),
          );
          init?.signal?.addEventListener("abort", () => {
            try {
              controller.close();
            } catch {
              /* already closed */
            }
          });
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
