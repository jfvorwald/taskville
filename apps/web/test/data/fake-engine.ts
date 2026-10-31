import {
  type DomainEvent,
  projectStateHash,
  REDUCER_VERSION,
  replay,
} from "../../../../packages/domain/src/reducer/index.ts";
import { storedEnvelopeSchemas } from "../../../../packages/protocol/src/index.ts";
import { SESSION_HEADER } from "../../src/pairing/pair.ts";

// A scripted stand-in for the engine's snapshot and SSE routes (contracts/http-api.md), served
// through a fake `fetch`. The log is real domain events, so the snapshot it serves is the real
// reducer's state and tests can compare the client's state against `replay(log)` by hash.

export const PROJECT = "p1";
export const SECRET = "s3cret";

/** A deterministic stored-envelope builder: sequence numbers from 1. */
export function eventBuilder(projectId = PROJECT) {
  let seq = 0;
  return <
    T extends "agent.registered" | "agent.connected" | "agent.disconnected" | "session.turn_failed",
  >(
    type: T,
    agentId: string,
    payload: Record<string, unknown> = {},
  ): DomainEvent => {
    seq += 1;
    const at = `2026-10-30T10:00:${String(seq % 60).padStart(2, "0")}Z`;
    const body =
      type === "agent.registered"
        ? {
            sourceAgentId: `src-${agentId}`,
            displayName: agentId,
            role: "dev",
            kind: "session",
            ...payload,
          }
        : payload;
    return storedEnvelopeSchemas[type].parse({
      schemaVersion: 1,
      projectId,
      sourceId: "test",
      sourceEventId: `e-${seq}`,
      occurredAt: at,
      type,
      payload: body,
      evidenceIds: [],
      provenance: "live",
      late: false,
      eventId: `00000000-0000-4000-8000-${seq.toString(16).padStart(12, "0")}`,
      receivedAt: at,
      ingestSequence: seq,
      agentId,
      sessionId: `s-${agentId}`,
    }) as DomainEvent;
  };
}

export function registered(emit: ReturnType<typeof eventBuilder>, ...ids: string[]): DomainEvent[] {
  return ids.map((id) => emit("agent.registered", id));
}

export const stateHashAt = (events: readonly DomainEvent[]): string =>
  projectStateHash(replay(PROJECT, events));

export interface RecordedRequest {
  url: string;
  headers: Headers;
}

interface OpenStream {
  controller: ReadableStreamDefaultController<Uint8Array>;
}

const encoder = new TextEncoder();

export class FakeEngine {
  log: DomainEvent[] = [];
  requests: RecordedRequest[] = [];
  /** When true, every request rejects like a refused connection. */
  down = false;
  /** When true, every request answers 401, like a revoked session. */
  revoked = false;
  reducerVersion = REDUCER_VERSION;
  private streams: OpenStream[] = [];

  constructor(initial: readonly DomainEvent[] = []) {
    this.log = [...initial];
  }

  get snapshotRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.includes("/snapshot"));
  }
  get streamRequests(): RecordedRequest[] {
    return this.requests.filter((r) => r.url.includes("/events"));
  }
  get openStreams(): number {
    return this.streams.length;
  }

  /** Appends to the log and sends to every open stream. */
  publish(...events: DomainEvent[]): void {
    this.log.push(...events);
    for (const event of events) this.send(frame("event", event, event.ingestSequence));
  }

  /** Appends to the log without sending: events a viewer misses while disconnected or cut off. */
  append(...events: DomainEvent[]): void {
    this.log.push(...events);
  }

  /** Sends a frame as written, to every open stream. */
  send(text: string): void {
    for (const stream of this.streams) stream.controller.enqueue(encoder.encode(text));
  }

  /** The connection drops with a network error. */
  drop(): void {
    const open = this.streams;
    this.streams = [];
    for (const stream of open) stream.controller.error(new TypeError("network error"));
  }

  /** The server ends the stream cleanly. */
  end(): void {
    const open = this.streams;
    this.streams = [];
    for (const stream of open) stream.controller.close();
  }

  /** A `resnapshot` frame, then the server closes the stream. */
  resnapshot(reason: string): void {
    this.send(frame("resnapshot", { reason }));
    this.end();
  }

  fetch = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = String(input);
    this.requests.push({ url, headers: new Headers(init?.headers) });
    if (this.down) throw new TypeError("fetch failed");
    if (this.revoked) return new Response('{"error":"unauthorized"}', { status: 401 });
    if (new Headers(init?.headers).get(SESSION_HEADER) !== SECRET) {
      return new Response('{"error":"unauthorized"}', { status: 401 });
    }
    const path = new URL(url, "http://127.0.0.1").pathname;
    if (path === `/v1/projects/${PROJECT}/snapshot`) return this.snapshot();
    if (path === `/v1/projects/${PROJECT}/events`) {
      return this.openStream(
        Number(new URL(url, "http://127.0.0.1").searchParams.get("after")),
        init,
      );
    }
    return new Response('{"error":"unknown_project"}', { status: 404 });
  };

  private snapshot(): Response {
    const state = replay(PROJECT, this.log);
    return new Response(
      JSON.stringify({
        projectId: PROJECT,
        cursor: state.head,
        reducerVersion: this.reducerVersion,
        stateHash: projectStateHash(state),
        state,
        attention: [],
        computedAt: "2026-10-30T10:30:00Z",
      }),
      { status: 200, headers: { "Content-Type": "application/json" } },
    );
  }

  private openStream(after: number, init: RequestInit | undefined): Response {
    const backlog = this.log.filter((event) => event.ingestSequence > after);
    let self: OpenStream | undefined;
    const body = new ReadableStream<Uint8Array>({
      start: (controller) => {
        self = { controller };
        for (const event of backlog) {
          controller.enqueue(encoder.encode(frame("event", event, event.ingestSequence)));
        }
        this.streams.push(self);
      },
      cancel: () => {
        this.streams = this.streams.filter((s) => s !== self);
      },
    });
    init?.signal?.addEventListener("abort", () => {
      this.streams = this.streams.filter((s) => s !== self);
      try {
        self?.controller.error(new DOMException("aborted", "AbortError"));
      } catch {
        // already closed
      }
    });
    return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
  }
}

export function frame(event: string, data: unknown, id?: number): string {
  return `${id === undefined ? "" : `id: ${id}\n`}event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
}

/** Resolves on the next macrotask, so a retry loop never spins the event loop dry. */
export const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 0));
