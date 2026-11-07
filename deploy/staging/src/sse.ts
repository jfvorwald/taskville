// Server-sent events in the wire format of Hono's `writeSSE`, which the engine writes with:
// `event`, then one `data:` line per line of data, then `id`, then a blank line.

import { SSE_HEARTBEAT_INTERVAL_MS } from "@taskville/protocol";

export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

export function formatSse(message: SseMessage): string {
  const data = message.data
    .split(/\r\n|\r|\n/)
    .map((line) => `data: ${line}`)
    .join("\n");
  return `${[
    `event: ${message.event}`,
    data,
    ...(message.id === undefined ? [] : [`id: ${message.id}`]),
  ].join("\n")}\n\n`;
}

export interface SseOptions {
  /** Sent every 15 s while the stream stays open. Without it the stream ends after `frames`. */
  heartbeat?: () => SseMessage;
}

/** The frames, then (with a heartbeat) an open stream until the client leaves. */
export function sseResponse(frames: readonly SseMessage[], options: SseOptions = {}): Response {
  const encoder = new TextEncoder();
  let timer: ReturnType<typeof setInterval> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const frame of frames) controller.enqueue(encoder.encode(formatSse(frame)));
      const { heartbeat } = options;
      if (heartbeat === undefined) {
        controller.close();
        return;
      }
      timer = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(formatSse(heartbeat())));
        } catch {
          clearInterval(timer);
        }
      }, SSE_HEARTBEAT_INTERVAL_MS);
    },
    cancel() {
      clearInterval(timer);
    },
  });
  return new Response(body, {
    headers: { "content-type": "text/event-stream", "cache-control": "no-store" },
  });
}
