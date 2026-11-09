import { mapCodexHook, type OpenToolCall, sessionAgentId } from "@taskville/adapters/codex";
import type { ProjectState } from "@taskville/domain/reducer";
import type { Logger } from "pino";
import type { IngestPipeline } from "../../ingest/index.ts";
import type { Storage } from "../../storage/index.ts";
import {
  ClaudeCodeSource,
  type HookIngested,
  type HookIngestResponse,
  type HookInput,
  type MapContext,
  type MapResult,
} from "../claude-code/index.ts";
import type { ResolveOptions } from "../claude-code/resolve-project.ts";

/** The source ID the protocol names for Codex telemetry. Every event this source ingests carries it. */
export const CODEX_SOURCE_ID = "codex";

/** Open tool calls remembered at once (oldest forgotten first): a call that never finishes is not kept forever. */
export const MAX_OPEN_TOOL_CALLS = 10_000;

export interface CodexSourceOptions extends ResolveOptions {
  pipeline: IngestPipeline;
  /** Project registry and projections: read on every hook, like the Claude Code source. */
  storage: Pick<Storage, "projects" | "findEventBySourceKey" | "head" | "projection">;
  now?: () => Date;
  logger?: Logger | undefined;
}

/** A call the source saw start and not finish, with what an Interrupt needs to find it. */
interface Open extends OpenToolCall {
  sessionId: string;
}

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const stringOf = (record: Record<string, unknown>, key: string): string | undefined => {
  const value = own(record, key);
  return typeof value === "string" ? value : undefined;
};

/**
 * The Codex telemetry source (A1.02, docs/spikes/S-5-codex.md): the Claude Code source's
 * project resolution, ingest, and idempotency on the Codex mapper (`mapCodexHook`, A1.01). What
 * the mapper cannot know from one hook comes from here: whether a session was seen to start (the
 * project's projection), and the tool calls still open per session and turn (kept in memory
 * from the hooks that were recorded), so an Interrupt can close those of its turn.
 *
 * Two entry points, as for Claude Code: the hooks route (`late: false`) and the spool replay
 * (`late: true`).
 */
export class CodexSource {
  readonly #inner: ClaudeCodeSource;
  readonly #storage: CodexSourceOptions["storage"];
  /** Insertion order is start order, so the oldest is the first key. */
  readonly #open = new Map<string, Open>();

  constructor(options: CodexSourceOptions) {
    this.#storage = options.storage;
    const { logger, ...rest } = options;
    this.#inner = new ClaudeCodeSource({
      ...rest,
      ...(logger === undefined ? {} : { logger }),
      sourceId: CODEX_SOURCE_ID,
      mapper: (payload, ctx) => this.#map(payload, ctx),
      afterIngest: (done) => this.#track(done),
    });
  }

  ingestHook(input: HookInput): Promise<HookIngestResponse> {
    return this.#inner.ingestHook(input);
  }

  #map(payload: unknown, ctx: MapContext): MapResult {
    const raw = typeof payload === "object" && payload !== null ? (payload as object) : {};
    const record = raw as Record<string, unknown>;
    const hook = stringOf(record, "hook_event_name");
    const sessionId = stringOf(record, "session_id");
    if (sessionId === undefined) return mapCodexHook(payload, ctx);
    if (hook === "SessionEnd") {
      return mapCodexHook(payload, { ...ctx, knownSession: this.#knownSession(ctx, sessionId) });
    }
    if (hook === "Interrupt") {
      const open = [...this.#open.values()].filter((call) => call.sessionId === sessionId);
      return mapCodexHook(payload, { ...ctx, openToolCalls: open });
    }
    return mapCodexHook(payload, ctx);
  }

  /** A session is known once its main agent is registered in the project's projection (it survives a restart). */
  #knownSession(ctx: MapContext, sessionId: string): boolean {
    const projection = this.#storage.projection<ProjectState>(ctx.projectId);
    const id = sessionAgentId(sessionId);
    // Registered, not merely present: any other hook for the session leaves a placeholder agent.
    return (
      projection !== undefined &&
      Object.hasOwn(projection.state.agents, id) &&
      projection.state.agents[id]?.registered === true
    );
  }

  /** Keeps `#open` in step with what was recorded: a call opens when its start is, and closes with its finish. */
  #track({ payload, mapped, results }: HookIngested): void {
    const sessionId = stringOf(payload, "session_id");
    if (sessionId === undefined) return;
    for (const [index, event] of mapped.events.entries()) {
      if (typeof event !== "object" || event === null) continue;
      const { type, payload: body } = event as { type?: unknown; payload?: unknown };
      const status = results[index]?.status;
      const toolCallId =
        typeof body === "object" && body !== null
          ? stringOf(body as Record<string, unknown>, "toolCallId")
          : undefined;
      if (type === "tool_call.started" && status === "accepted" && toolCallId !== undefined) {
        this.#remember(sessionId, toolCallId, payload);
      } else if (type === "tool_call.finished" && toolCallId !== undefined) {
        if (status === "accepted" || status === "duplicate") this.#open.delete(toolCallId);
      } else if (type === "session.ended" && status === "accepted") {
        for (const [id, call] of this.#open)
          if (call.sessionId === sessionId) this.#open.delete(id);
      }
    }
  }

  #remember(sessionId: string, toolCallId: string, payload: Record<string, unknown>): void {
    const turnId = stringOf(payload, "turn_id");
    const sourceAgentId = stringOf(payload, "agent_id");
    this.#open.delete(toolCallId);
    this.#open.set(toolCallId, {
      toolCallId,
      sessionId,
      ...(turnId === undefined ? {} : { turnId }),
      ...(sourceAgentId === undefined ? {} : { sourceAgentId }),
    });
    if (this.#open.size > MAX_OPEN_TOOL_CALLS) {
      const [oldest] = this.#open.keys();
      if (oldest !== undefined) this.#open.delete(oldest);
    }
  }
}
