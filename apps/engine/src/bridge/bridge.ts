import { randomUUID } from "node:crypto";
import { redactJson } from "@taskville/adapters/redact";
import { hashCanonical } from "@taskville/domain/hash";
import { BRIDGE_SOURCE_ID } from "@taskville/domain/reducer/attention";
import {
  ID_MAX_LENGTH,
  INPUT_PREVIEW_MAX_CHARS,
  RESERVED_SOURCE_PREFIX,
} from "@taskville/protocol";
import type { Logger } from "pino";
import type { IngestPipeline } from "../ingest/index.ts";
import { resolveProjectId } from "../sources/claude-code/index.ts";
import type { Storage } from "../storage/index.ts";
import type { StreamHub } from "../stream/index.ts";
import { commitEngineEvent } from "./commit.ts";

/** Hold window default (decision #116 D1): 90 seconds, whether or not a viewer is focused. */
export const DEFAULT_HOLD_WINDOW_MS = 90_000;

/**
 * Requests the bridge remembers for matching a later PostToolUse (oldest forgotten first). A
 * forgotten request is never closed by a PostToolUse; it still expires at the next engine start.
 * Forgetting one could hide that a later identical request is a duplicate, so a session that
 * lost a request is never attributed a PostToolUse again (the ambiguity check stays safe).
 */
export const MAX_TRACKED_REQUESTS = 1000;

/** `request.opened` for a request the bridge is not holding: red, but never answerable. */
const UNHELD_SOURCE_ID = `${RESERVED_SOURCE_PREFIX}bridge-unheld`;
const SOURCE_ID = "claude-code";

/** What a city user decides (the M4.03 command service calls `decide`). */
export type BridgeDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

/** A held request as the decision card needs it: the exact input, never stored or logged. */
export interface HeldRequest {
  requestId: string;
  projectId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
}

export interface PermissionBridgeOptions {
  storage: Storage;
  /**
   * Accepted so the bridge is composed from the same parts as the other sources. Not used: the
   * pipeline refuses the `taskville:` source, so the bridge commits through `commitEngineEvent`.
   */
  pipeline?: IngestPipeline;
  hub: StreamHub;
  /** How long a hook response is held for the city, in milliseconds. Default 90,000. */
  holdWindowMs?: number;
  /** Runs `run` after `delayMs` and returns a cancel function. Defaults to `setTimeout`. */
  schedule?: (run: () => void, delayMs: number) => () => void;
  now?: () => Date;
  newRequestId?: () => string;
  newEventId?: () => string;
  logger?: Logger;
}

interface Held extends HeldRequest {
  signal: AbortSignal;
  agentId: string;
  resolve: (response: Response) => void;
  cancelTimer: () => void;
  onAbort: () => void;
}

interface Tracked {
  projectId: string;
  sessionId: string;
  agentId: string;
  /** Session, prompt, tool name, and input hash, as S-1 correlates them; undefined if unhashable. */
  key: string | undefined;
  /** `open` until the bridge records an outcome or a city decision reaches the hook. */
  state: "open" | "closed";
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

const idText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= ID_MAX_LENGTH
    ? value
    : undefined;

/** The hook's answer when Taskville does not answer: Claude Code falls through to its own dialog. */
const fallThrough = (): Response => new Response("", { status: 200 });

function decisionResponse(decision: BridgeDecision): Response {
  return Response.json({
    hookSpecificOutput: {
      hookEventName: "PermissionRequest",
      decision:
        decision.behavior === "allow"
          ? { behavior: "allow" }
          : { behavior: "deny", message: decision.message },
    },
  });
}

function correlationKey(
  sessionId: string,
  promptId: string | undefined,
  toolName: string,
  toolInput: unknown,
): string | undefined {
  try {
    return hashCanonical([sessionId, promptId ?? null, toolName, toolInput ?? null]);
  } catch {
    return undefined;
  }
}

/** The masked, capped copy of a tool input that events and the projection carry. */
function inputPreview(toolInput: unknown): string | undefined {
  if (toolInput === undefined) return undefined;
  try {
    const { value } = redactJson(JSON.parse(JSON.stringify(toolInput)));
    const text = JSON.stringify(value);
    return text === undefined ? undefined : [...text].slice(0, INPUT_PREVIEW_MAX_CHARS).join("");
  } catch {
    return undefined;
  }
}

/**
 * The permission bridge (ARCHITECTURE.md 8.1 and 9, S-1, decision #116). It holds each
 * PermissionRequest hook response open so a paired viewer can answer it, and records how the
 * request ended. The exact tool input lives only in a held request's memory, for the decision
 * card; events, the projection, logs, and errors get the masked copy.
 */
export class PermissionBridge {
  readonly #options: PermissionBridgeOptions;
  readonly #holdWindowMs: number;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  readonly #held = new Map<string, Held>();
  readonly #tracked = new Map<string, Tracked>();
  /** Sessions with a forgotten request: their PostToolUse closes nothing. */
  readonly #lossySessions = new Set<string>();
  #closed = false;

  constructor(options: PermissionBridgeOptions) {
    this.#options = options;
    this.#holdWindowMs = options.holdWindowMs ?? DEFAULT_HOLD_WINDOW_MS;
    this.#schedule =
      options.schedule ??
      ((run, delayMs) => {
        const timer = setTimeout(run, delayMs);
        return () => clearTimeout(timer);
      });
  }

  /**
   * Handles one raw PermissionRequest hook body. Resolves with the hook's answer: the allow or
   * deny JSON when the city decided, otherwise an empty 200 (fall through to the terminal
   * dialog). Resolves undefined when the body is not a usable hook. `signal` aborts when Claude
   * Code closes the connection.
   */
  async handle(raw: unknown, signal: AbortSignal): Promise<Response | undefined> {
    if (!isRecord(raw)) return undefined;
    const sessionId = idText(own(raw, "session_id"));
    const toolName = idText(own(raw, "tool_name"));
    if (sessionId === undefined || toolName === undefined) return undefined;
    const toolInput = own(raw, "tool_input");
    const promptId = idText(own(raw, "prompt_id"));
    const agentId = `${SOURCE_ID}:${sessionId}`;

    const projectId = await resolveProjectId(own(raw, "cwd"), this.#options.storage.projects());
    if (this.#closed) return fallThrough();
    // A viewer is a stream open on the hook's project. With none, nobody can answer: the request
    // is still recorded (the agent turns red) but is not bridge-held, so it is not answerable.
    const hold =
      !signal.aborted && this.#options.hub.subscriberCount(projectId) > 0 && !this.#closed;
    const requestId = (this.#options.newRequestId ?? (() => `bridge:request:${randomUUID()}`))();
    const preview = inputPreview(toolInput);
    const opened = this.#commit({
      projectId,
      sourceId: hold ? BRIDGE_SOURCE_ID : UNHELD_SOURCE_ID,
      sourceEventId: `request.opened:${requestId}`,
      agentId,
      sessionId,
      type: "request.opened",
      ...(promptId === undefined ? {} : { correlationId: promptId }),
      payload: {
        requestId,
        kind: "permission",
        toolName,
        ...(preview === undefined ? {} : { inputPreview: preview }),
      },
    });
    if (opened === undefined) return fallThrough();

    this.#track(requestId, {
      projectId,
      sessionId,
      agentId,
      key: correlationKey(sessionId, promptId, toolName, toolInput),
      state: "open",
    });
    if (!hold) return fallThrough();

    return new Promise<Response>((resolve) => {
      const onAbort = () => this.#closedByTerminal(requestId);
      const held: Held = {
        requestId,
        projectId,
        sessionId,
        agentId,
        toolName,
        toolInput,
        signal,
        resolve,
        cancelTimer: () => {},
        onAbort,
      };
      this.#held.set(requestId, held);
      signal.addEventListener("abort", onAbort, { once: true });
      // The hold ends with an empty 2xx; the request stays open (see class docs on fall-through).
      held.cancelTimer = this.#schedule(
        () => this.#take(requestId)?.resolve(fallThrough()),
        this.#holdWindowMs,
      );
    });
  }

  /** The exact input of a request that is still held, or undefined. */
  lookup(requestId: string): HeldRequest | undefined {
    const held = this.#held.get(requestId);
    if (held === undefined) return undefined;
    const { projectId, sessionId, toolName, toolInput } = held;
    return { requestId, projectId, sessionId, toolName, toolInput };
  }

  /**
   * Answers a held hook. True only when the decision reached a still-open response; a response
   * that was released, timed out, or whose connection closed reaches nothing. Records no events:
   * the command service (M4.03) records `answered_here` and the command's progress, and a
   * delivered decision is "sent, unconfirmed" (decision #116 D4).
   */
  decide(requestId: string, decision: BridgeDecision): boolean {
    const held = this.#held.get(requestId);
    if (held === undefined || held.signal.aborted) return false;
    this.#take(requestId);
    this.#close(requestId);
    held.resolve(decisionResponse(decision));
    return true;
  }

  /**
   * Telemetry the bridge may use: a PostToolUse that matches exactly one PermissionRequest (same
   * session, prompt, tool name, and input) shows the user allowed it in the terminal (decision
   * #116 D3), so that request closes as `answered_elsewhere` with `decision: "allow"`. Anything
   * else, a Notification and other same-session events included, closes nothing. Two requests
   * with identical correlation fields (open or already closed) are ambiguous and close nothing.
   */
  observeHook(raw: unknown): void {
    if (!isRecord(raw) || own(raw, "hook_event_name") !== "PostToolUse") return;
    const sessionId = idText(own(raw, "session_id"));
    const toolName = idText(own(raw, "tool_name"));
    if (sessionId === undefined || toolName === undefined) return;
    if (this.#lossySessions.has(sessionId)) return;
    const key = correlationKey(
      sessionId,
      idText(own(raw, "prompt_id")),
      toolName,
      own(raw, "tool_input"),
    );
    if (key === undefined) return;
    const matches = [...this.#tracked].filter(([, tracked]) => tracked.key === key);
    const [match] = matches;
    if (matches.length !== 1 || match === undefined) return;
    const [requestId, tracked] = match;
    if (tracked.state !== "open") return;
    tracked.state = "closed";
    this.#recordTerminal(requestId, tracked, "allow");
    this.#take(requestId)?.resolve(fallThrough());
  }

  /** Releases every held response with an empty 2xx and writes nothing (engine shutdown). */
  close(): void {
    this.#closed = true;
    for (const requestId of [...this.#held.keys()]) this.#take(requestId)?.resolve(fallThrough());
  }

  /** Claude Code closed the hook connection before any city answer: a terminal No (#116 D2). */
  #closedByTerminal(requestId: string): void {
    const held = this.#take(requestId);
    const tracked = this.#tracked.get(requestId);
    if (held === undefined) return;
    if (tracked !== undefined && tracked.state === "open") {
      tracked.state = "closed";
      this.#recordTerminal(requestId, tracked, "deny");
    }
    held.resolve(fallThrough());
  }

  #recordTerminal(requestId: string, tracked: Tracked, decision: "allow" | "deny"): void {
    this.#commit({
      projectId: tracked.projectId,
      sourceId: BRIDGE_SOURCE_ID,
      sourceEventId: `request.resolved:${requestId}`,
      agentId: tracked.agentId,
      sessionId: tracked.sessionId,
      type: "request.resolved",
      payload: { requestId, resolution: "answered_elsewhere", decision },
    });
  }

  /** Removes a held request, stops its timer and listener, and drops its exact input. */
  #take(requestId: string): Held | undefined {
    const held = this.#held.get(requestId);
    if (held === undefined) return undefined;
    this.#held.delete(requestId);
    held.cancelTimer();
    held.signal.removeEventListener("abort", held.onAbort);
    return held;
  }

  #close(requestId: string): void {
    const tracked = this.#tracked.get(requestId);
    if (tracked !== undefined) tracked.state = "closed";
  }

  #track(requestId: string, tracked: Tracked): void {
    this.#tracked.set(requestId, tracked);
    if (this.#tracked.size > MAX_TRACKED_REQUESTS) {
      const [oldest] = this.#tracked;
      if (oldest !== undefined) {
        this.#tracked.delete(oldest[0]);
        this.#lossySessions.add(oldest[1].sessionId);
      }
    }
  }

  #commit(event: Record<string, unknown>) {
    return commitEngineEvent(
      {
        storage: this.#options.storage,
        hub: this.#options.hub,
        ...(this.#options.now ? { now: this.#options.now } : {}),
        ...(this.#options.newEventId ? { newEventId: this.#options.newEventId } : {}),
        ...(this.#options.logger ? { logger: this.#options.logger } : {}),
      },
      {
        schemaVersion: 1,
        occurredAt: (this.#options.now ?? (() => new Date()))().toISOString(),
        evidenceIds: [],
        provenance: "live",
        late: false,
        ...event,
      },
    );
  }
}

export function createPermissionBridge(options: PermissionBridgeOptions): PermissionBridge {
  return new PermissionBridge(options);
}
