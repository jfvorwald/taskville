import { randomUUID } from "node:crypto";
import { attributeHook, isHookId } from "@taskville/adapters/claude-code";
import { sessionAgentId, stripNamespace, subagentAgentId } from "@taskville/adapters/codex";
import { redactJson } from "@taskville/adapters/redact";
import { hashCanonical } from "@taskville/domain/hash";
import type { ProjectState } from "@taskville/domain/reducer";
import { BRIDGE_SOURCE_ID } from "@taskville/domain/reducer/attention";
import {
  ID_MAX_LENGTH,
  INPUT_PREVIEW_MAX_CHARS,
  RESERVED_SOURCE_PREFIX,
} from "@taskville/protocol";
import type { Logger } from "pino";
import { resolveProjectId } from "../sources/claude-code/index.ts";
import type { Storage } from "../storage/index.ts";
import type { StreamHub } from "../stream/index.ts";
import { commitEngineEvent, type EngineCommitOptions } from "./commit.ts";

/** Hold window default (decision #116 D1): 90 seconds, whether or not a viewer is focused. */
export const DEFAULT_HOLD_WINDOW_MS = 90_000;

/**
 * Hold window default for Codex (A1.02, S-5 gap 1): 5 seconds. While a Codex PermissionRequest
 * hook runs, its terminal prompt is hidden, so a long hold would leave the user at a blank screen.
 */
export const DEFAULT_CODEX_HOLD_WINDOW_MS = 5_000;

/**
 * Codex tool calls the bridge remembers between PreToolUse and PostToolUse, to tell whether a
 * PostToolUse could belong to more than one call (oldest forgotten first). Once one is forgotten
 * no PostToolUse closes a request until the engine restarts (fail closed, like the lossy sessions).
 */
export const MAX_TRACKED_CODEX_CALLS = 2000;

/**
 * Requests the bridge remembers for matching a later PostToolUse (oldest forgotten first). A
 * forgotten request is never closed by a PostToolUse; it still expires at the next engine start.
 * Forgetting one could hide that a later identical request is a duplicate, so a session that
 * lost a request is never attributed a PostToolUse again (the ambiguity check stays safe).
 */
export const MAX_TRACKED_REQUESTS = 1000;

/** Sessions that lost a request and so close nothing by PostToolUse (oldest forgotten first). */
export const MAX_LOSSY_SESSIONS = 1000;

/** Hook responses held at once; a request over the cap is recorded but not held. */
export const MAX_HELD = 64;

/** Serialized `tool_input` size in UTF-8 bytes a held request may keep; larger inputs are not held. */
export const MAX_HELD_INPUT_BYTES = 262_144;

/** `request.opened` for a request the bridge is not holding: red, but never answerable. */
const UNHELD_SOURCE_ID = `${RESERVED_SOURCE_PREFIX}bridge-unheld`;

/** What a city user decides (the M4.03 command service calls `decide`). */
export type BridgeDecision = { behavior: "allow" } | { behavior: "deny"; message: string };

/** A held request as the decision card needs it: the exact input, never stored or logged. */
export interface HeldRequest {
  requestId: string;
  projectId: string;
  sessionId: string;
  toolName: string;
  toolInput: unknown;
  /** The hook's working directory, when it sent one. */
  cwd?: string;
}

export interface PermissionBridgeOptions {
  storage: Storage;
  hub: StreamHub;
  onCommit?: EngineCommitOptions["onCommit"];
  /** How long a hook response is held for the city, in milliseconds. Default 90,000. */
  holdWindowMs?: number;
  /** Like `holdWindowMs`, for Codex requests. Default 5,000. */
  codexHoldWindowMs?: number;
  /** Runs `run` after `delayMs` and returns a cancel function. Defaults to `setTimeout`. */
  schedule?: (run: () => void, delayMs: number) => () => void;
  now?: () => Date;
  /** Milliseconds on a monotonic clock, to time the hold. Defaults to `performance.now()`. */
  monotonicNowMs?: () => number;
  newRequestId?: () => string;
  newEventId?: () => string;
  logger?: Logger;
}

interface Held extends HeldRequest {
  signal: AbortSignal;
  resolve: (response: Response) => void;
  cancelTimer: () => void;
  onAbort: () => void;
  /** When the hold began (engine clock), to tell a hook timeout from a terminal No. */
  heldAtMs: number;
}

interface Tracked {
  projectId: string;
  sessionId: string;
  agentId: string;
  /** Session, agent, prompt, tool name, and input hash, as S-1 correlates them; undefined if unhashable. */
  key: string | undefined;
  /** `open` until the bridge records an outcome or a city decision reaches the hook. */
  state: "open" | "closed";
  /** Codex only: the hook's `turn_id`, so an Interrupt of that turn can close the request. */
  turnId?: string;
}

/** A Codex tool call between its PreToolUse and PostToolUse. */
interface CodexCall {
  key: string | undefined;
  sessionId: string;
  turnId: string | undefined;
}

/** Everything `#open` needs to record and hold one permission request, whichever agent sent it. */
interface OpenSpec {
  sessionId: string;
  agentId: string;
  toolName: string;
  toolInput: unknown;
  /** The hook's raw `cwd`, which names the project. */
  rawCwd: unknown;
  correlationId: string | undefined;
  key: string | undefined;
  turnId?: string;
  holdMs: number;
  /** False when the hook's mode means nobody could answer (Codex `bypassPermissions`). */
  holdable: boolean;
  /**
   * What a closed hook connection means. Claude Code: the user answered No in the terminal.
   * Codex: nothing is known (a hook timeout looks the same), so the hold is only released.
   */
  onClose: "deny" | "release";
  signal: AbortSignal;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const own = (record: Record<string, unknown>, key: string): unknown =>
  Object.hasOwn(record, key) ? record[key] : undefined;

/** Telemetry's bound on `prompt_id` (adapters' `map.ts`); a value outside it counts as absent. */
const MAX_PROMPT_ID = 100;

/** The hook's `prompt_id`, validated as telemetry does so the request and its PostToolUse agree. */
const promptIdOf = (raw: Record<string, unknown>): string | undefined => {
  const id = own(raw, "prompt_id");
  return isHookId(id, MAX_PROMPT_ID) ? id : undefined;
};

const idText = (value: unknown): string | undefined =>
  typeof value === "string" && value.length > 0 && value.length <= ID_MAX_LENGTH
    ? value
    : undefined;

/** Whether a tool input is small enough to keep in memory while its hook response is held. */
function withinHeldInputCap(toolInput: unknown): boolean {
  try {
    const text = JSON.stringify(toolInput);
    return (text === undefined ? 0 : Buffer.byteLength(text, "utf8")) <= MAX_HELD_INPUT_BYTES;
  } catch {
    return false;
  }
}

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
  sourceAgentId: string | undefined,
  promptId: string | undefined,
  toolName: string,
  toolInput: unknown,
): string | undefined {
  try {
    return hashCanonical([
      sessionId,
      sourceAgentId ?? null,
      promptId ?? null,
      toolName,
      toolInput ?? null,
    ]);
  } catch {
    return undefined;
  }
}

/** Who sent a Codex hook, as the Codex telemetry mapper names them (`codex:<session>[:<agent>]`). */
function codexSubject(
  raw: Record<string, unknown>,
): { agentId: string; sourceAgentId?: string } | undefined {
  const attribution = attributeHook(raw);
  if (!attribution.ok) return undefined;
  const { sessionId, sourceAgentId } = attribution.subject;
  return sourceAgentId === undefined
    ? { agentId: sessionAgentId(sessionId) }
    : { agentId: subagentAgentId(sessionId, sourceAgentId), sourceAgentId };
}

/**
 * Session, turn, agent, tool, and input, so a PostToolUse can be matched to a request. The
 * request's `tool_input` carries a `description` the PostToolUse's does not (S-5), so it is left
 * out; for Bash that leaves the command.
 */
function codexKey(
  sessionId: string,
  turnId: string | undefined,
  sourceAgentId: string | undefined,
  toolName: string,
  toolInput: unknown,
): string | undefined {
  try {
    const input = isRecord(toolInput) ? { ...toolInput, description: undefined } : toolInput;
    return hashCanonical([
      "codex",
      sessionId,
      turnId ?? null,
      sourceAgentId ?? null,
      toolName,
      input === undefined ? null : JSON.parse(JSON.stringify(input)),
    ]);
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
  readonly #codexHoldWindowMs: number;
  readonly #schedule: (run: () => void, delayMs: number) => () => void;
  readonly #held = new Map<string, Held>();
  readonly #tracked = new Map<string, Tracked>();
  /** Codex calls between Pre and Post, by `tool_use_id`. */
  readonly #codexCalls = new Map<string, CodexCall>();
  #codexCallsLossy = false;
  /** Sessions with a forgotten request: their PostToolUse closes nothing. */
  readonly #lossySessions = new Set<string>();
  /**
   * Set once a session fell off `#lossySessions`: from then on a forgotten request may belong to
   * any session, so no PostToolUse closes anything until the engine restarts (fail closed).
   */
  #lossyOverflow = false;
  #closed = false;

  constructor(options: PermissionBridgeOptions) {
    this.#options = options;
    this.#holdWindowMs = options.holdWindowMs ?? DEFAULT_HOLD_WINDOW_MS;
    this.#codexHoldWindowMs = options.codexHoldWindowMs ?? DEFAULT_CODEX_HOLD_WINDOW_MS;
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
    // The hook's agent, as telemetry attributes it. A hook telemetry would ignore (a bad agent_id)
    // gets the empty 2xx and records nothing.
    const attribution = attributeHook(raw);
    if (!attribution.ok) return fallThrough();
    const { agentId, sourceAgentId } = attribution.subject;
    const toolInput = own(raw, "tool_input");
    const promptId = promptIdOf(raw);
    return this.#open({
      sessionId,
      agentId,
      toolName,
      toolInput,
      rawCwd: own(raw, "cwd"),
      correlationId: promptId,
      key: correlationKey(sessionId, sourceAgentId, promptId, toolName, toolInput),
      holdMs: this.#holdWindowMs,
      holdable: true,
      onClose: "deny",
      signal,
    });
  }

  /**
   * The Codex twin of `handle` (A1.02, S-5 gaps 1, 2 and 5): the same hold, with a 5 second
   * window, the Codex session or subagent as the agent, no hold for a `bypassPermissions` session
   * (nobody is asked, so nothing is answerable), and a closed connection read as nothing (Codex
   * kills a hook that runs over its timeout, which looks like a terminal answer but is not one).
   */
  async handleCodex(raw: unknown, signal: AbortSignal): Promise<Response | undefined> {
    if (!isRecord(raw)) return undefined;
    const sessionId = idText(own(raw, "session_id"));
    const rawToolName = idText(own(raw, "tool_name"));
    if (sessionId === undefined || rawToolName === undefined) return undefined;
    const subject = codexSubject(raw);
    if (subject === undefined) return fallThrough();
    const toolName = stripNamespace(rawToolName) ?? rawToolName;
    const toolInput = own(raw, "tool_input");
    const turnId = idText(own(raw, "turn_id"));
    return this.#open({
      sessionId,
      agentId: subject.agentId,
      toolName,
      toolInput,
      rawCwd: own(raw, "cwd"),
      correlationId: turnId,
      key: codexKey(sessionId, turnId, subject.sourceAgentId, toolName, toolInput),
      ...(turnId === undefined ? {} : { turnId }),
      holdMs: this.#codexHoldWindowMs,
      holdable: own(raw, "permission_mode") !== "bypassPermissions",
      onClose: "release",
      signal,
    });
  }

  async #open(spec: OpenSpec): Promise<Response> {
    const { sessionId, agentId, toolName, toolInput, signal } = spec;
    const hookCwd = spec.rawCwd;
    const cwd = typeof hookCwd === "string" ? hookCwd : undefined;

    const projectId = await resolveProjectId(spec.rawCwd, this.#options.storage.projects());
    if (this.#closed) return fallThrough();
    // A viewer is a stream open on the hook's project. With none, nobody can answer: the request
    // is still recorded (the agent turns red) but is not bridge-held, so it is not answerable.
    const hold =
      spec.holdable &&
      !signal.aborted &&
      this.#options.hub.subscriberCount(projectId) > 0 &&
      !this.#closed &&
      this.#held.size < MAX_HELD &&
      withinHeldInputCap(toolInput);
    const requestId = (this.#options.newRequestId ?? (() => `bridge:request:${randomUUID()}`))();
    const preview = inputPreview(toolInput);
    const opened = this.#commit({
      projectId,
      sourceId: hold ? BRIDGE_SOURCE_ID : UNHELD_SOURCE_ID,
      sourceEventId: `request.opened:${requestId}`,
      agentId,
      sessionId,
      type: "request.opened",
      ...(spec.correlationId === undefined ? {} : { correlationId: spec.correlationId }),
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
      key: spec.key,
      state: "open",
      ...(spec.turnId === undefined ? {} : { turnId: spec.turnId }),
    });
    if (!hold) return fallThrough();

    return new Promise<Response>((resolve) => {
      const onAbort = () => {
        // An abort listener that throws is an uncaught exception; the hold is released regardless.
        try {
          if (spec.onClose === "deny") this.#closedByTerminal(requestId);
          else this.#take(requestId)?.resolve(fallThrough());
        } catch (error) {
          this.#logFailure(error, "bridge terminal outcome failed");
        }
      };
      const held: Held = {
        requestId,
        projectId,
        sessionId,
        toolName,
        toolInput,
        ...(cwd === undefined ? {} : { cwd }),
        signal,
        resolve,
        cancelTimer: () => {},
        onAbort,
        heldAtMs: this.#nowMs(),
      };
      this.#held.set(requestId, held);
      signal.addEventListener("abort", onAbort, { once: true });
      // The hold ends with an empty 2xx; the request stays open (see class docs on fall-through).
      held.cancelTimer = this.#schedule(
        () => this.#take(requestId)?.resolve(fallThrough()),
        spec.holdMs,
      );
    });
  }

  /** The exact input of a request that is still held, or undefined. */
  lookup(requestId: string): HeldRequest | undefined {
    const held = this.#held.get(requestId);
    if (held === undefined) return undefined;
    const { projectId, sessionId, toolName, toolInput, cwd } = held;
    return {
      requestId,
      projectId,
      sessionId,
      toolName,
      toolInput,
      ...(cwd === undefined ? {} : { cwd }),
    };
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
    if (this.#closed) return;
    try {
      this.#observeHook(raw);
    } catch (error) {
      this.#logFailure(error, "bridge telemetry outcome failed");
    }
  }

  /**
   * Telemetry the Codex bridge may use, from every hook the Codex route accepted (A1.02):
   * - PreToolUse and PostToolUse: a PostToolUse closes a request as `answered_elsewhere` with
   *   `allow` only when exactly one open request and no other open call share its session, turn,
   *   agent, tool, and command. A PermissionRequest has no `tool_use_id`, so anything less sure
   *   closes nothing and the request falls to the normal hold expiry.
   * - Interrupt: the open requests of that turn close as `answered_elsewhere` with no decision
   *   (Esc and a plain interrupt look the same), and their holds are released.
   */
  observeCodexHook(raw: unknown): void {
    if (this.#closed) return;
    try {
      this.#observeCodexHook(raw);
    } catch (error) {
      this.#logFailure(error, "bridge codex telemetry outcome failed");
    }
  }

  /** Counts for tests and diagnostics: no request content. */
  stats(): { held: number; tracked: number; lossySessions: number } {
    return {
      held: this.#held.size,
      tracked: this.#tracked.size,
      lossySessions: this.#lossySessions.size,
    };
  }

  #observeHook(raw: unknown): void {
    if (!isRecord(raw) || own(raw, "hook_event_name") !== "PostToolUse") return;
    const sessionId = idText(own(raw, "session_id"));
    const toolName = idText(own(raw, "tool_name"));
    if (sessionId === undefined || toolName === undefined) return;
    if (this.#tracked.size === 0) return;
    const attribution = attributeHook(raw);
    if (!attribution.ok) return;
    if (this.#lossyOverflow || this.#lossySessions.has(sessionId)) return;
    const key = correlationKey(
      sessionId,
      attribution.subject.sourceAgentId,
      promptIdOf(raw),
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
    try {
      this.#recordTerminal(requestId, tracked, "allow");
    } finally {
      this.#take(requestId)?.resolve(fallThrough());
    }
  }

  #observeCodexHook(raw: unknown): void {
    if (!isRecord(raw)) return;
    const hook = own(raw, "hook_event_name");
    const sessionId = idText(own(raw, "session_id"));
    if (sessionId === undefined) return;
    const subject = codexSubject(raw);
    if (subject === undefined) return;
    const turnId = idText(own(raw, "turn_id"));
    switch (hook) {
      case "PreToolUse":
      case "PostToolUse": {
        const callId = idText(own(raw, "tool_use_id"));
        const rawName = idText(own(raw, "tool_name"));
        if (callId === undefined || rawName === undefined) return;
        const toolName = stripNamespace(rawName) ?? rawName;
        const key = codexKey(
          sessionId,
          turnId,
          subject.sourceAgentId,
          toolName,
          own(raw, "tool_input"),
        );
        if (hook === "PreToolUse") this.#rememberCodexCall(callId, { key, sessionId, turnId });
        else this.#codexPostToolUse(callId, sessionId, key);
        return;
      }
      case "Interrupt":
      case "Stop":
        // Session hooks: one from inside a subagent says nothing about the session's turn.
        if (subject.sourceAgentId !== undefined || turnId === undefined) return;
        this.#forgetCodexCalls(sessionId, turnId);
        if (hook === "Interrupt") this.#codexInterrupt(sessionId, turnId);
        return;
      case "SessionEnd":
        if (subject.sourceAgentId === undefined) this.#forgetCodexCalls(sessionId, undefined);
        return;
      default:
        return;
    }
  }

  #rememberCodexCall(callId: string, call: CodexCall): void {
    this.#codexCalls.delete(callId);
    this.#codexCalls.set(callId, call);
    if (this.#codexCalls.size <= MAX_TRACKED_CODEX_CALLS) return;
    const [oldest] = this.#codexCalls.keys();
    if (oldest !== undefined) this.#codexCalls.delete(oldest);
    this.#codexCallsLossy = true;
  }

  /** Drops the calls of a turn (every turn when `turnId` is undefined) that will see no PostToolUse. */
  #forgetCodexCalls(sessionId: string, turnId: string | undefined): void {
    for (const [id, call] of this.#codexCalls) {
      if (call.sessionId === sessionId && (turnId === undefined || call.turnId === turnId)) {
        this.#codexCalls.delete(id);
      }
    }
  }

  #codexPostToolUse(callId: string, sessionId: string, key: string | undefined): void {
    // Only a call whose PreToolUse was tracked can say which request it ends: a Post alone proves
    // nothing, and the Pre of a forgotten call may have been the one the request was for.
    const tracked = this.#codexCalls.get(callId);
    this.#codexCalls.delete(callId);
    if (tracked === undefined || tracked.key !== key || tracked.sessionId !== sessionId) return;
    if (key === undefined || this.#codexCallsLossy || this.#lossyOverflow) return;
    if (this.#lossySessions.has(sessionId)) return;
    // Another open call with the same fields could be the one the request was for.
    for (const call of this.#codexCalls.values()) if (call.key === key) return;
    const matches = [...this.#tracked].filter(
      ([, tracked]) => tracked.key === key && tracked.state === "open",
    );
    const [match] = matches;
    if (matches.length !== 1 || match === undefined) return;
    this.#closeCodexRequest(match[0], match[1], "allow");
  }

  #codexInterrupt(sessionId: string, turnId: string): void {
    for (const [requestId, tracked] of [...this.#tracked]) {
      if (tracked.state !== "open" || tracked.sessionId !== sessionId) continue;
      if (tracked.turnId !== turnId) continue;
      this.#closeCodexRequest(requestId, tracked, undefined);
    }
  }

  #closeCodexRequest(requestId: string, tracked: Tracked, decision: "allow" | undefined): void {
    tracked.state = "closed";
    try {
      this.#recordTerminal(requestId, tracked, decision);
    } finally {
      this.#take(requestId)?.resolve(fallThrough());
    }
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
    // The hook's own timeout is the hold window plus a margin. A close after the window means the
    // hold timer was late (a stalled event loop), so it is a timeout, not an answer: record
    // nothing and let the request expire at the next start.
    try {
      const timedOut = this.#nowMs() - held.heldAtMs >= this.#holdWindowMs;
      if (!timedOut && tracked !== undefined && tracked.state === "open") {
        tracked.state = "closed";
        this.#recordTerminal(requestId, tracked, "deny");
      }
    } finally {
      held.resolve(fallThrough());
    }
  }

  #recordTerminal(
    requestId: string,
    tracked: Tracked,
    decision: "allow" | "deny" | undefined,
  ): void {
    // A request the projection merged into another ("one prompt, one red state") has no record of
    // its own; resolving its ID would close the record it was merged into, which may be a
    // different request whose hook is still held.
    const projection = this.#options.storage.projection<ProjectState>(tracked.projectId);
    if (projection === undefined || !Object.hasOwn(projection.state.requests, requestId)) return;
    this.#commit({
      projectId: tracked.projectId,
      sourceId: BRIDGE_SOURCE_ID,
      sourceEventId: `request.resolved:${requestId}`,
      agentId: tracked.agentId,
      sessionId: tracked.sessionId,
      type: "request.resolved",
      payload: {
        requestId,
        resolution: "answered_elsewhere",
        ...(decision === undefined ? {} : { decision }),
      },
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

  /** Monotonic, so a wall-clock jump cannot turn a terminal answer into a timeout. */
  #nowMs(): number {
    return (this.#options.monotonicNowMs ?? (() => performance.now()))();
  }

  #close(requestId: string): void {
    const tracked = this.#tracked.get(requestId);
    if (tracked !== undefined) tracked.state = "closed";
  }

  #track(requestId: string, tracked: Tracked): void {
    this.#tracked.set(requestId, tracked);
    if (this.#tracked.size <= MAX_TRACKED_REQUESTS) return;
    // Never forget a request whose hook is still held: the city could no longer answer it.
    for (const [id, entry] of this.#tracked) {
      if (this.#held.has(id)) continue;
      this.#tracked.delete(id);
      this.#markLossy(entry.sessionId);
      return;
    }
  }

  #markLossy(sessionId: string): void {
    this.#lossySessions.delete(sessionId);
    this.#lossySessions.add(sessionId);
    if (this.#lossySessions.size > MAX_LOSSY_SESSIONS) {
      const [oldest] = this.#lossySessions;
      if (oldest !== undefined) this.#lossySessions.delete(oldest);
      this.#lossyOverflow = true;
    }
  }

  /** Logs the error name only: a storage error message can carry request content. */
  #logFailure(error: unknown, message: string): void {
    this.#options.logger?.error({ errName: (error as Error).name }, message);
  }

  #commit(event: Record<string, unknown>) {
    return commitEngineEvent(
      {
        storage: this.#options.storage,
        hub: this.#options.hub,
        ...(this.#options.onCommit ? { onCommit: this.#options.onCommit } : {}),
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
