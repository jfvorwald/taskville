import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach } from "vitest";
import { type BootOptions, bootEngine, type Engine } from "../../src/stream/index.ts";
import { bearer, CLI_TOKEN, makeApp } from "../http/helpers.ts";

export { addProject, input } from "../ingest/helpers.ts";

export const BASE = "http://127.0.0.1:4807";

/** A temporary Taskville database directory per test. */
export function useDbPath(): () => string {
  let dir = "";
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "taskville-stream-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });
  return () => join(dir, "taskville.db");
}

/** Boots an engine on an in-process app (no socket) and returns it with the app. */
export function bootInProcess(
  dbPath: string,
  options: Partial<Omit<BootOptions, "app" | "dbPath" | "pairing">> = {},
) {
  const { app, pairing } = makeApp();
  const engine = bootEngine({ app, dbPath, pairing, heartbeatMs: 60_000, ...options });
  return { app, pairing, engine };
}

export async function ingest(
  app: ReturnType<typeof makeApp>["app"],
  events: unknown[],
): Promise<void> {
  const res = await app.request(`${BASE}/v1/events/batch`, {
    method: "POST",
    headers: { ...bearer(CLI_TOKEN), "Content-Type": "application/json" },
    body: JSON.stringify({ events }),
  });
  if (res.status !== 200) throw new Error(`ingest failed: ${res.status}`);
}

export interface Frame {
  event: string;
  id?: number;
  data: unknown;
}

/** Reads SSE frames from a fetch Response body, as a browser client would with fetch streaming. */
export class SseReader {
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";
  #done = false;
  /** A read that timed out in `next`: kept so the chunk it receives is not lost. */
  #pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>["read"]> | undefined;

  constructor(res: Response) {
    if (!res.body) throw new Error("no body");
    this.#reader = res.body.getReader();
  }

  /** The next frame, or null when the stream ended. Rejects after `timeoutMs`. */
  async next(timeoutMs = 2000): Promise<Frame | null> {
    for (;;) {
      const end = this.#buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        return parseFrame(block);
      }
      if (this.#done) return null;
      let timer: NodeJS.Timeout | undefined;
      // A timed-out wait leaves its read pending; the next call reuses it, so the chunk that read
      // receives is not swallowed.
      const read = this.#pending ?? this.#reader.read();
      this.#pending = read;
      const chunk = await Promise.race([
        read,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error("timed out waiting for a frame")), timeoutMs);
        }),
      ]).finally(() => clearTimeout(timer));
      this.#pending = undefined;
      if (chunk.done) this.#done = true;
      else this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  /** Reads frames until `count` event frames arrived (or the stream ended). */
  async events(count: number, timeoutMs = 2000): Promise<Frame[]> {
    const out: Frame[] = [];
    while (out.length < count) {
      const frame = await this.next(timeoutMs);
      if (frame === null) break;
      if (frame.event === "event") out.push(frame);
    }
    return out;
  }

  async cancel(): Promise<void> {
    await this.#reader.cancel();
  }
}

function parseFrame(block: string): Frame {
  let event = "message";
  let id: number | undefined;
  const data: string[] = [];
  for (const line of block.split("\n")) {
    if (line.startsWith("event: ")) event = line.slice(7);
    else if (line.startsWith("id: ")) id = Number(line.slice(4));
    else if (line.startsWith("data: ")) data.push(line.slice(6));
  }
  const frame: Frame = { event, data: JSON.parse(data.join("\n")) };
  if (id !== undefined) frame.id = id;
  return frame;
}

export function streamRequest(
  app: ReturnType<typeof makeApp>["app"],
  projectId: string,
  headers: Record<string, string>,
  query = "",
): Promise<Response> {
  return Promise.resolve(
    app.request(`${BASE}/v1/projects/${projectId}/events${query}`, { headers }),
  );
}

export type { Engine };
