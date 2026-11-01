import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { freePort, startServe, tempDir } from "../helpers.ts";

// Shared by the M4.04 serve tests: a real `taskville serve` composition (in process, temp home,
// fixed engine clock) with a registered project, a paired browser session, and the three kinds of
// client the bridge talks to: the Claude Code PermissionRequest hook (bridge token), the telemetry
// shim (CLI token), and the browser (session + Origin).

export const PROJECT = "demo";
export const CWD = "/tmp/spike-s1/proj";
export const SESSION = "eaff5d10-daac-4e32-b35f-87f91ca81c8f";
export const PROMPT = "03dc4896-8835-47f5-a515-94a1ad4c675c";
export const HOOK_PATH = "/v1/bridge/claude-code/permission";
export const TELEMETRY_PATH = "/v1/sources/claude-code/hooks";
const CLOCK = new Date("2026-10-31T12:00:00Z");

export interface StoredEvent {
  type: string;
  ingestSequence: number;
  sourceId: string;
  agentId?: string;
  sessionId?: string;
  payload: Record<string, unknown>;
}

/** A project event stream read with fetch streaming, as the web client does. */
export class Viewer {
  readonly events: StoredEvent[] = [];
  readonly #reader: ReadableStreamDefaultReader<Uint8Array>;
  readonly #decoder = new TextDecoder();
  #buffer = "";

  private constructor(res: Response) {
    if (res.body === null) throw new Error("no stream body");
    this.#reader = res.body.getReader();
  }

  static async open(url: string, session: string, projectId = PROJECT): Promise<Viewer> {
    const res = await fetch(`${url}/v1/projects/${projectId}/events?after=0`, {
      headers: { "X-Taskville-Session": session },
    });
    if (res.status !== 200) throw new Error(`stream refused: ${res.status}`);
    return new Viewer(res);
  }

  async #pump(timeoutMs: number): Promise<boolean> {
    for (;;) {
      const end = this.#buffer.indexOf("\n\n");
      if (end >= 0) {
        const block = this.#buffer.slice(0, end);
        this.#buffer = this.#buffer.slice(end + 2);
        const name = /^event: (.*)$/m.exec(block)?.[1];
        const data = /^data: (.*)$/m.exec(block)?.[1];
        if (name === "event" && data !== undefined) {
          this.events.push(JSON.parse(data) as StoredEvent);
          return true;
        }
        continue;
      }
      let timer: NodeJS.Timeout | undefined;
      const chunk = await Promise.race([
        this.#reader.read(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () => reject(new Error("timed out waiting for a stream event")),
            timeoutMs,
          );
        }),
      ]).finally(() => clearTimeout(timer));
      if (chunk.done) return false;
      this.#buffer += this.#decoder.decode(chunk.value, { stream: true });
    }
  }

  /** The first event (already seen or still to come) that satisfies `match`. */
  async waitFor(match: (event: StoredEvent) => boolean, timeoutMs = 5000): Promise<StoredEvent> {
    for (;;) {
      const found = this.events.find(match);
      if (found !== undefined) return found;
      if (!(await this.#pump(timeoutMs))) throw new Error("stream ended before the event arrived");
    }
  }

  /** Reads until `count` events were seen in all (used right after connecting). */
  async waitForCount(count: number, timeoutMs = 5000): Promise<void> {
    while (this.events.length < count) {
      if (!(await this.#pump(timeoutMs))) throw new Error("stream ended early");
    }
  }

  of(type: string): StoredEvent[] {
    return this.events.filter((event) => event.type === type);
  }

  async close(): Promise<void> {
    await this.#reader.cancel().catch(() => {});
  }
}

export interface BridgeServe {
  url: string;
  home: string;
  cliToken: string;
  bridgeToken: string;
  /** A paired browser session secret. */
  session: string;
  output(): string;
  errors(): string;
  stop(): Promise<number>;
  /** Removes the temp home; call after `stop`. */
  remove(): void;
  /** A PermissionRequest hook as Claude Code sends it (bridge token); the promise settles when the hold ends. */
  hook(overrides?: Record<string, unknown>, signal?: AbortSignal): Promise<Response>;
  /** A raw hook through the telemetry route, as the shim sends it (CLI token). */
  telemetry(payload: Record<string, unknown>, sourceEventId?: string): Promise<Response>;
  /** `POST /v1/commands` as the paired browser. */
  command(body: unknown): Promise<Response>;
  /** `GET /v1/requests/:id/input` as the paired browser. */
  requestInput(requestId: string, projectId?: string): Promise<Response>;
  /** The project's snapshot (CLI token). */
  snapshot(projectId?: string): Promise<{ cursor: number; state: Record<string, unknown> }>;
  /** Every event of a project (default: demo), read from a fresh stream. */
  allEvents(projectId?: string): Promise<StoredEvent[]>;
  /** Registers another project (CLI token). */
  addProject(id: string, root: string): Promise<void>;
  /** Opens a viewer stream and waits until it is connected (the backfill has begun). */
  viewer(): Promise<Viewer>;
}

let counter = 0;
const uuid = (): string => {
  counter += 1;
  return `00000000-0000-4000-8000-${counter.toString(16).padStart(12, "0")}`;
};

export function permissionRequest(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: `/Users/dev/.claude/projects/-tmp-spike-s1-proj/${SESSION}.jsonl`,
    cwd: CWD,
    prompt_id: PROMPT,
    permission_mode: "default",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "touch exp1.txt", description: "Create empty file exp1.txt" },
    permission_suggestions: [],
    ...overrides,
  };
}

export function postToolUse(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION,
    cwd: CWD,
    prompt_id: PROMPT,
    permission_mode: "default",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: "touch exp1.txt", description: "Create empty file exp1.txt" },
    tool_response: { stdout: "", stderr: "", interrupted: false },
    tool_use_id: "toolu_01Vht1XR3ioUBvjrANoTYgWa",
    duration_ms: 254,
    ...overrides,
  };
}

export async function startBridgeServe(
  options: { config?: Record<string, unknown> } = {},
): Promise<BridgeServe> {
  const dir = tempDir("taskville-bridge-serve-");
  if (options.config !== undefined) {
    writeFileSync(join(dir.path, "config.json"), JSON.stringify(options.config), { mode: 0o600 });
  }
  const serve = await startServe(dir.path, await freePort(), () => CLOCK);
  const { url } = serve;
  const cliToken = readFileSync(join(dir.path, "token"), "utf8").trim();
  const bridgeToken = readFileSync(join(dir.path, "bridge-token"), "utf8").trim();
  const code = /#pair=([A-Za-z0-9_-]+)/.exec(serve.output())?.[1];
  const paired = await fetch(`${url}/v1/pairing`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Origin: url },
    body: JSON.stringify({ code }),
  });
  if (paired.status !== 200) throw new Error(`pairing failed: ${paired.status}`);
  const session = ((await paired.json()) as { session: string }).session;
  const created = await fetch(`${url}/v1/projects`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${cliToken}` },
    body: JSON.stringify({ id: PROJECT, name: "Demo", roots: [CWD] }),
  });
  if (created.status !== 201) throw new Error(`project create failed: ${created.status}`);

  const cli = { "Content-Type": "application/json", Authorization: `Bearer ${cliToken}` };
  const browser = { "X-Taskville-Session": session, Origin: url };
  const harness: BridgeServe = {
    url,
    home: dir.path,
    cliToken,
    bridgeToken,
    session,
    output: serve.output,
    errors: serve.errors,
    stop: serve.stop,
    remove: dir.remove,
    hook: (overrides = {}, signal) =>
      fetch(`${url}${HOOK_PATH}`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${bridgeToken}` },
        body: JSON.stringify(permissionRequest(overrides)),
        ...(signal === undefined ? {} : { signal }),
      }),
    telemetry: (payload, sourceEventId = uuid()) =>
      fetch(`${url}${TELEMETRY_PATH}`, {
        method: "POST",
        headers: cli,
        body: JSON.stringify({ sourceEventId, payload }),
      }),
    command: (body) =>
      fetch(`${url}/v1/commands`, {
        method: "POST",
        headers: { "Content-Type": "application/json", ...browser },
        body: JSON.stringify(body),
      }),
    requestInput: (requestId, projectId = PROJECT) =>
      fetch(`${url}/v1/requests/${encodeURIComponent(requestId)}/input?projectId=${projectId}`, {
        headers: { "X-Taskville-Session": session },
      }),
    snapshot: async (projectId = PROJECT) => {
      const res = await fetch(`${url}/v1/projects/${projectId}/snapshot`, { headers: cli });
      return (await res.json()) as { cursor: number; state: Record<string, unknown> };
    },
    addProject: async (id, root) => {
      const res = await fetch(`${url}/v1/projects`, {
        method: "POST",
        headers: cli,
        body: JSON.stringify({ id, name: id, roots: [root] }),
      });
      if (res.status !== 201) throw new Error(`project create failed: ${res.status}`);
    },
    allEvents: async (projectId = PROJECT) => {
      const { cursor } = await harness.snapshot(projectId);
      const viewer = await Viewer.open(url, session, projectId);
      try {
        await viewer.waitForCount(cursor);
        return viewer.events;
      } finally {
        await viewer.close();
      }
    },
    viewer: async () => {
      const viewer = await Viewer.open(url, session);
      // The project has at least its creation event, so one event means the subscription is live.
      await viewer.waitForCount(1);
      return viewer;
    },
  };
  return harness;
}

/** The SessionStart that registers the agent, as Claude Code sends it first. */
export const sessionStart = (): Record<string, unknown> => ({
  session_id: SESSION,
  transcript_path: `/Users/dev/.claude/projects/-tmp-spike-s1-proj/${SESSION}.jsonl`,
  cwd: CWD,
  hook_event_name: "SessionStart",
  source: "startup",
});
