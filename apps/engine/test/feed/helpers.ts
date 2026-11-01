import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { StoredEnvelope } from "@taskville/protocol";
import type { Hono } from "hono";
import { afterEach, beforeEach } from "vitest";
import { type EvidenceStore, openEvidenceStore } from "../../src/evidence/index.ts";
import type { AppEnv } from "../../src/http/app.ts";
import { createProject } from "../../src/projects/index.ts";
import { ClaudeCodeSource, mapClaudeCodeHook } from "../../src/sources/claude-code/index.ts";
import { bootEngine, type Engine } from "../../src/stream/index.ts";
import { bearer, CLI_TOKEN, makeApp } from "../http/helpers.ts";
import { hookId } from "../sources/claude-code/helpers.ts";
import { type Frame, SseReader } from "../stream/helpers.ts";

export const BASE = "http://127.0.0.1:4807";

// M5.01 pins `registerFeedRoutes` in apps/engine/src/feed/index.ts. It is loaded by a computed
// path, and only when the file exists, so that before the implementation exists the suite fails
// on the missing routes (404 instead of 200) and on the explicit export check in
// feed-module.test.ts, not on an import error that hides every assertion.
const FEED_MODULE_PATH = join(import.meta.dirname, "../../src/feed/index.ts");
const FEED_MODULE_SPECIFIER = "../../src/feed/index.ts";

/** What `registerFeedRoutes(app, options)` takes (pinned by these tests). */
export interface FeedRouteOptions {
  storage: Engine["storage"];
  hub: Engine["hub"];
  /** Same PairingStore as `createApp`: revoking pairings ends browser-session feeds. */
  pairing: ReturnType<typeof makeApp>["pairing"];
  evidence: EvidenceStore;
  /** Engine clock: `elapsedMs` of a running crew member is `now - startedAt`. */
  now?: () => Date;
  heartbeatMs?: number;
  queueLimit?: number;
  maxStreams?: number;
  drainTimeoutMs?: number;
}
export type RegisterFeedRoutes = (app: Hono<AppEnv>, options: FeedRouteOptions) => void;

export async function loadRegisterFeedRoutes(): Promise<RegisterFeedRoutes | undefined> {
  if (!existsSync(FEED_MODULE_PATH)) return undefined;
  const mod = (await import(/* @vite-ignore */ FEED_MODULE_SPECIFIER)) as {
    registerFeedRoutes?: RegisterFeedRoutes;
  };
  return mod.registerFeedRoutes;
}

/** Hook ingest time: each clock read is one second later, from this instant. */
export const INGEST_START_MS = Date.parse("2026-10-31T12:00:00.000Z");
/** The route clock: well after every ingested hook, so a running member has a known elapsed time. */
export const ROUTE_NOW = new Date("2026-10-31T13:00:00.000Z");

export const FIXTURES = join(import.meta.dirname, "../../../../fixtures/claude-code");
export const SPIKE_CWD = "/tmp/spike-s2/proj";

export interface HarnessOptions {
  capBytes?: number;
  queueLimit?: number;
  maxStreams?: number;
  drainTimeoutMs?: number;
}

export interface PlayOptions {
  /** Project that holds the hooks' cwd as a root; default "spike". */
  project?: string;
  /** Replaces every hook's cwd (to land a recording in another project). */
  cwd?: string;
  /** Index of the first hook to send (default 0). */
  from?: number;
  /** Stop before sending the first hook this is true for (the hook is not sent). */
  stopBefore?: (hook: Record<string, unknown>) => boolean;
  /** Stop after the first hook whose events make this true, checked after each hook. */
  stopAfter?: (events: StoredEnvelope[]) => boolean;
  /** Distinguishes sourceEventIds when the same file is played twice. */
  tag?: string;
}

export interface Harness {
  app: Hono<AppEnv>;
  pairing: ReturnType<typeof makeApp>["pairing"];
  engine: Engine;
  evidence: EvidenceStore;
  source: ClaudeCodeSource;
  addProject(id: string, root: string): void;
  events(projectId: string): StoredEnvelope[];
  /** Sends one raw hook payload through the real Claude Code mapper. */
  hook(payload: Record<string, unknown>, label: string): Promise<void>;
  /** Plays a recording from `fixtures/claude-code`; returns the index of the next hook to send. */
  play(file: string, options?: PlayOptions): Promise<number>;
  get(path: string, headers?: Record<string, string>): Promise<Response>;
  feed(agentId: string, query?: string, headers?: Record<string, string>): Promise<Response>;
  crew(agentId: string, query?: string, headers?: Record<string, string>): Promise<Response>;
  evidenceBody(id: string, headers?: Record<string, string>): Promise<Response>;
  /** Opens a feed with the CLI token and wraps it for frame reading. */
  openFeed(agentId: string, query?: string): Promise<SseReader>;
  close(): void;
}

/**
 * Per-test temp directory plus a factory for engines with the feed routes registered. Engines
 * are closed after each test.
 */
export function useHarness(): (options?: HarnessOptions) => Promise<Harness> {
  let dir = "";
  const open: Harness[] = [];
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "taskville-feed-"));
  });
  afterEach(() => {
    for (const harness of open.splice(0)) harness.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return async (options = {}) => {
    const register = await loadRegisterFeedRoutes();
    let tick = 0;
    const ingestClock = () => new Date(INGEST_START_MS + 1000 * tick++);
    const { app, pairing } = makeApp();
    const engine = bootEngine({
      app,
      dbPath: join(dir, `taskville-${open.length}.db`),
      pairing,
      now: ingestClock,
      heartbeatMs: 60_000,
      ...(options.queueLimit === undefined ? {} : { queueLimit: options.queueLimit }),
      ...(options.maxStreams === undefined ? {} : { maxStreams: options.maxStreams }),
      ...(options.drainTimeoutMs === undefined ? {} : { drainTimeoutMs: options.drainTimeoutMs }),
    });
    const evidence = openEvidenceStore(join(dir, `evidence-${open.length}.db`), {
      now: ingestClock,
      ...(options.capBytes === undefined ? {} : { capBytes: options.capBytes }),
    });
    const source = new ClaudeCodeSource({
      pipeline: engine.pipeline,
      storage: engine.storage,
      mapper: mapClaudeCodeHook,
      evidence,
      now: ingestClock,
    });
    register?.(app, {
      storage: engine.storage,
      hub: engine.hub,
      pairing,
      evidence,
      now: () => ROUTE_NOW,
      heartbeatMs: 60_000,
      queueLimit: engine.queueLimit,
      maxStreams: engine.maxStreams,
      drainTimeoutMs: engine.drainTimeoutMs,
    });

    const get = (path: string, headers: Record<string, string> = bearer(CLI_TOKEN)) =>
      Promise.resolve(app.request(`${BASE}${path}`, { headers }));
    const agentPath = (agentId: string, tail: string, query: string) =>
      `/v1/agents/${encodeURIComponent(agentId)}/${tail}${query}`;
    const harness: Harness = {
      app,
      pairing,
      engine,
      evidence,
      source,
      addProject(id, root) {
        createProject(engine.storage, { id, name: id, roots: [root] }, { now: ingestClock });
      },
      events: (projectId) => [...engine.storage.events(projectId, 0)],
      async hook(payload, label) {
        await source.ingestHook({ sourceEventId: hookId(label), payload });
      },
      async play(file, play = {}) {
        const project = play.project ?? "spike";
        const lines = readFileSync(join(FIXTURES, file), "utf8")
          .split("\n")
          .filter((line) => line.trim() !== "");
        let index = play.from ?? 0;
        for (; index < lines.length; index++) {
          const input = (JSON.parse(lines[index] ?? "{}") as { input: Record<string, unknown> })
            .input;
          if (play.stopBefore?.(input)) return index;
          const payload = play.cwd === undefined ? input : { ...input, cwd: play.cwd };
          await source.ingestHook({
            sourceEventId: hookId(`${file}#${index}#${play.tag ?? ""}`),
            payload,
          });
          if (play.stopAfter?.(harness.events(project))) return index + 1;
        }
        return index;
      },
      get,
      feed: (agentId, query = "", headers) => get(agentPath(agentId, "feed", query), headers),
      crew: (agentId, query = "", headers) => get(agentPath(agentId, "crew", query), headers),
      evidenceBody: (id, headers) => get(`/v1/evidence/${encodeURIComponent(id)}`, headers),
      async openFeed(agentId, query = "") {
        const res = await harness.feed(agentId, query);
        if (res.status !== 200) throw new Error(`feed answered ${res.status}`);
        return new SseReader(res);
      },
      close() {
        engine.close();
        evidence.close();
      },
    };
    open.push(harness);
    return harness;
  };
}

// --- Recorded IDs (S-2 fixtures). Agent IDs are the adapters' attribution. ---

export const PARALLEL = {
  file: "subagent/parallel.jsonl",
  session: "1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5",
  lead: "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5",
  /** Reads, Edits and runs `wc -l` on notes.txt. */
  a: "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5:afdf84bea07a9064c",
  /** Writes hello.txt and runs `cat`. */
  b: "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5:a0b4668e13e056653",
  aRead: "toolu_013yYY4xd5K3RFMzMz8e5i7C",
  aEdit: "toolu_01BFbfwiNzH1amZ3p2p6TGUm",
  aBash: "toolu_01VQt15Q1ofuUjxj8YqTpPsK",
  leadFailingBash: "toolu_01PE3uiFG5Rfwytm3PJY1Edg",
} as const;

export const NESTED = {
  file: "subagent/nested.jsonl",
  lead: "claude-code:6effc000-24c8-436e-ae5e-33152b820f83",
  outer: "claude-code:6effc000-24c8-436e-ae5e-33152b820f83:ac5497782768787b9",
  inner: "claude-code:6effc000-24c8-436e-ae5e-33152b820f83:a0c1bc9a2c30e80b6",
} as const;

export const IN_PROCESS_TEAM = {
  file: "team/in-process.jsonl",
  lead: "claude-code:cf46f41b-8048-4a06-b955-b342dd0c7f31",
  pip: "claude-code:cf46f41b-8048-4a06-b955-b342dd0c7f31:apip-5cb5e9bb3f2f1097",
  bo: "claude-code:cf46f41b-8048-4a06-b955-b342dd0c7f31:abo-4381c522227780d5",
} as const;

export const SPLIT_PANE_TEAM = {
  file: "team/split-pane.jsonl",
  lead: "claude-code:a7286c33-05b8-4a44-af6b-76733867aab0",
  pip: "claude-code:cf7d0732-a271-4cf7-9a11-d0918b72fbd0",
  bo: "claude-code:f1b7a717-fe78-44d8-b68b-a12643262b81",
} as const;

/** An internal helper agent that fired a PreToolUse and never a PostToolUse (S-2). */
export const UNMATCHED = {
  file: "team/split-pane-speculative.jsonl",
  agent: "claude-code:a127629f-0c4d-49ad-b316-3e9dc4eaa48c:a352b542cb1a1f4d5",
  toolCallId: "toolu_01CMjHCZEEgbjMYJBXx66fdB",
} as const;

// --- Pinned response shapes ---

export interface EvidenceRef {
  /** Opaque; pass it URL-encoded to `GET /v1/evidence/:id`. */
  id: string;
  status: "stored" | "evicted";
}

/** `data` of an `event: toolcall` frame; the SSE `id` is the ingest sequence of the event behind it. */
export interface ToolCallFrame {
  toolCallId: string;
  agentId: string;
  toolName: string;
  /** `unfinished`: the reducer closed the call with no PostToolUse (the session or agent ended). */
  phase: "running" | "succeeded" | "failed" | "unfinished";
  startedAt?: string;
  finishedAt?: string;
  durationMs?: number;
  summary?: string;
  filePaths: string[];
  evidence: { input: EvidenceRef | null; output: EvidenceRef | null };
}

export interface CrewMember {
  agentId: string;
  kind: "subagent" | "teammate";
  displayName?: string;
  /** Claude Code `agent_type` for a subagent; the role for a teammate. */
  agentType?: string;
  parentAgentId?: string;
  status: "running" | "finished";
  currentActivity?: { activity: string; since: string; heuristic: boolean };
  startedAt: string;
  finishedAt?: string;
  elapsedMs: number;
  resultSummary?: string;
  /** True only for a member whose name, kind, or link rests on a heuristic. */
  heuristic: boolean;
  children: CrewMember[];
}

export interface CrewResponse {
  agentId: string;
  projectId: string;
  team?: { id: string; name?: string; leadAgentId: string; startedAt: string; endedAt?: string };
  subagents: CrewMember[];
  teammates: CrewMember[];
}

export interface EvidenceResponse {
  id: string;
  projectId: string;
  toolCallId: string;
  part: "input" | "output";
  text: string;
  masks: { start: number; end: number; kind: string }[];
  truncated: boolean;
  bytes: number;
}

// --- Frame reading ---

/** The next `count` tool call frames (heartbeats are skipped); fails on a `resnapshot` or timeout. */
export async function toolCallFrames(
  reader: SseReader,
  count: number,
  timeoutMs = 2000,
): Promise<{ id: number; data: ToolCallFrame }[]> {
  const out: { id: number; data: ToolCallFrame }[] = [];
  while (out.length < count) {
    const frame = await reader.next(timeoutMs);
    if (frame === null) throw new Error(`feed ended after ${out.length} of ${count} frames`);
    if (frame.event === "heartbeat") continue;
    if (frame.event !== "toolcall") {
      throw new Error(`unexpected frame ${frame.event}: ${JSON.stringify(frame.data)}`);
    }
    out.push({ id: frame.id ?? -1, data: frame.data as ToolCallFrame });
  }
  return out;
}

/** Asserts nothing more arrives within `ms`. */
export async function expectQuiet(reader: SseReader, ms = 150): Promise<void> {
  let frame: Frame | null | "quiet";
  try {
    frame = await reader.next(ms);
  } catch {
    frame = "quiet";
  }
  if (frame !== "quiet" && frame?.event !== "heartbeat") {
    throw new Error(`expected no more frames, got ${JSON.stringify(frame)}`);
  }
}

/** Ingests raw domain events (agent.registered and the like) that no hook mapper would send. */
export function ingestRaw(
  h: Harness,
  projectId: string,
  label: string,
  events: { type: string; agentId: string; at: string; payload: Record<string, unknown> }[],
): void {
  const response = h.engine.pipeline.ingest(
    events.map((e, i) => ({
      schemaVersion: 1,
      projectId,
      sourceId: "adapter:test",
      sourceEventId: `${label}#${i}`,
      occurredAt: e.at,
      type: e.type,
      agentId: e.agentId,
      payload: e.payload,
      provenance: "live",
    })),
  );
  for (const result of response.results) {
    if (result.status !== "accepted")
      throw new Error(`raw ingest ${label}: ${JSON.stringify(result)}`);
  }
}

/** The ingest sequences of the tool call events (started and finished) one agent fired. */
export function toolCallSequences(events: StoredEnvelope[], agentId: string): number[] {
  return events
    .filter((e) => e.agentId === agentId && e.type.startsWith("tool_call."))
    .map((e) => e.ingestSequence);
}

export const isRecordedAs =
  (type: string, agentId: string) =>
  (events: StoredEnvelope[]): boolean =>
    events.some((e) => e.type === type && e.agentId === agentId);

// --- Synthetic Bash calls (real hook shape, as in the S-2 recordings) ---

export interface BashCall {
  session: string;
  toolUseId: string;
  command: string;
  /** The tool_response stdout; when absent the call stays open (no PostToolUse is sent). */
  stdout?: string;
  cwd?: string;
  /** Distinguishes the shim's sourceEventIds. */
  label: string;
}

/** The lead agent ID the adapters give a session. */
export const leadOf = (session: string): string => `claude-code:${session}`;

/** Sends a PreToolUse and, when `stdout` is given, the matching PostToolUse. */
export async function runBash(h: Harness, call: BashCall): Promise<void> {
  const base = {
    session_id: call.session,
    cwd: call.cwd ?? SPIKE_CWD,
    permission_mode: "default",
    tool_name: "Bash",
    tool_input: { command: call.command, description: `Run ${call.toolUseId}` },
    tool_use_id: call.toolUseId,
  };
  await h.hook({ ...base, hook_event_name: "PreToolUse" }, `${call.label}#pre`);
  if (call.stdout === undefined) return;
  await h.hook(
    {
      ...base,
      hook_event_name: "PostToolUse",
      tool_response: {
        stdout: call.stdout,
        stderr: "",
        interrupted: false,
        isImage: false,
        noOutputExpected: false,
      },
      duration_ms: 7,
    },
    `${call.label}#post`,
  );
}

/** The evidence reference ids of a ToolCall's finished frame, read from the agent's feed. */
export async function evidenceIdsOf(
  h: Harness,
  agentId: string,
  toolCallId: string,
  query = "",
): Promise<{ input: string; output: string }> {
  const reader = await h.openFeed(agentId, query);
  try {
    for (;;) {
      const [frame] = await toolCallFrames(reader, 1);
      if (frame?.data.toolCallId === toolCallId && frame.data.phase !== "running") {
        return {
          input: frame.data.evidence.input?.id ?? "",
          output: frame.data.evidence.output?.id ?? "",
        };
      }
    }
  } finally {
    await reader.cancel();
  }
}
