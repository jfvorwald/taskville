import { createHash, randomUUID } from "node:crypto";
import { realpath } from "node:fs/promises";
import { isAbsolute, relative, sep } from "node:path";
import type { Command, PendingRequest, ProjectState, Session } from "@taskville/domain/reducer";
import type { CommandStatus, CommandType } from "@taskville/protocol";
import type { Logger } from "pino";
import {
  type BridgeDecision,
  commitEngineEvent,
  type EngineCommitOptions,
  type HeldRequest,
} from "../bridge/index.ts";
import { ENGINE_SOURCE_ID } from "../storage/index.ts";
import type { Engine } from "../stream/index.ts";
import {
  defaultIsDirectory,
  type OpenSessionConfig,
  type OpenSessionExecFile,
  openSession,
} from "./open-session.ts";
import {
  type CommandBody,
  commandBodySchema,
  type PermissionDecideBody,
  type SessionOpenBody,
} from "./schema.ts";

export type { HeldRequest } from "../bridge/index.ts";

// The command service (ARCHITECTURE.md 9, decision #116 D4). Every command is recorded as events
// from `taskville:engine`: command.requested first, then its outcome. A city decision is "sent,
// unconfirmed" once it reaches a still-open hook response (command.delivered); the service never
// records command.succeeded for permission.decide, because telemetry confirmation is M4.04's.

/** What the bridge gives the service: the held request and the answer to its hook response. */
export type CommandBridgeDecision = BridgeDecision;

export interface CommandBridge {
  lookup(requestId: string): HeldRequest | undefined;
  /** True only when the decision reached a still-open hook response. */
  decide(requestId: string, decision: CommandBridgeDecision): boolean;
}

export interface CommandServiceOptions {
  /** The booted engine; the service uses its storage and stream hub. */
  engine: Pick<Engine, "storage" | "hub">;
  bridge: CommandBridge;
  /** The opener comes only from the loaded engine config, never from a request. */
  opener: { config: OpenSessionConfig; execFile: OpenSessionExecFile };
  now?: () => Date;
  newId?: () => string;
  logger?: Logger;
  /** Session results kept for replays and `GET`, oldest forgotten first. Defaults to 500. */
  maxRememberedResults?: number;
}

/** What a command's response and `GET /v1/commands/:id` show. */
export interface CommandView {
  id: string;
  type: CommandType;
  requestId: string;
  status: CommandStatus;
  result?: SessionOpenResult;
}

export interface SessionOpenResult {
  outcome: "opened" | "copy-only";
  sessionId: string;
  cwd?: string;
}

/** An HTTP status and its JSON body, so the service stays independent of the web framework. */
export interface CommandResult {
  status: number;
  body: unknown;
}

export interface CommandService {
  /** Handles a `POST /v1/commands` body (already parsed from JSON, or undefined if it was not). */
  submit(body: unknown): Promise<CommandResult>;
  /** Handles `GET /v1/commands/:id`. */
  get(commandId: string): CommandResult;
}

/** The note the agent sees when a deny carries none (the bridge's hook response needs one). */
const DEFAULT_DENY_MESSAGE = "Denied in Taskville";

// Start-up recovery cannot know how a cut-short command ended, so the reason says so instead of
// presenting a guess as fact (constitution IV).
const INTERRUPTED_OPENER_MESSAGE =
  "The engine stopped before the outcome was recorded; the session may have opened";
const INTERRUPTED_DECISION_MESSAGE =
  "The engine stopped before the outcome was recorded; the decision may have reached Claude Code";
const OPENER_CWD_REFUSED_MESSAGE = "The session directory is not inside a project root";

/** Session results kept for replaying an idempotent session.open (oldest forgotten first). */
const DEFAULT_MAX_REMEMBERED_RESULTS = 500;

/** Directory name endings that macOS launches instead of opening as a folder. */
const LAUNCHABLE_SUFFIXES = [".app", ".command", ".workflow", ".terminal", ".tool"];

// C0 (but not tab and newline), DEL, and C1 controls.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping control characters is the point
const NOTE_CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

type ErrorCode =
  | "bad_request"
  | "command_in_flight"
  | "history_context_rejected"
  | "idempotency_conflict"
  | "not_answerable"
  | "opener_failed"
  | "request_expired"
  | "request_not_open"
  | "request_session_mismatch"
  | "unknown_command"
  | "unknown_project"
  | "unknown_request"
  | "unknown_session";

const MESSAGES: Record<ErrorCode, string> = {
  bad_request: "The command body is not valid",
  command_in_flight: "An earlier command for this session is still running",
  history_context_rejected: "Commands are not accepted from history",
  idempotency_conflict: "That idempotency key was already used for a different command",
  not_answerable: "Taskville cannot answer this request; answer it in the terminal",
  opener_failed: "The session opener failed",
  request_expired: "The request can no longer be answered here",
  request_not_open: "The request is no longer open",
  request_session_mismatch: "The request belongs to another session",
  unknown_command: "No such command",
  unknown_project: "No such project",
  unknown_request: "No such request",
  unknown_session: "No such session",
};

export function createCommandService(options: CommandServiceOptions): CommandService {
  const { engine, bridge, opener } = options;
  const maxRememberedResults = options.maxRememberedResults ?? DEFAULT_MAX_REMEMBERED_RESULTS;
  const now = options.now ?? (() => new Date());
  const newId = options.newId ?? randomUUID;
  const commitOptions: EngineCommitOptions = {
    storage: engine.storage,
    hub: engine.hub,
    now,
    ...(options.logger ? { logger: options.logger } : {}),
  };
  /** Sessions with an opener running; one at a time per session. */
  const opening = new Set<string>();
  /** Results of session.open commands, for replays and `GET`. Not in the log. */
  const results = new Map<string, SessionOpenResult>();
  /**
   * permission.decide commands whose hook was answered but whose `command.delivered` could not be
   * appended: the log still says `requested`, the agent has its answer, so they show `delivered`.
   */
  const deliveredHere = new Set<string>();
  /** Which project a command belongs to; unknown IDs fall back to scanning the projections. */
  const commandProjects = new Map<string, string>();

  /** Only the error name is logged: a message can carry paths and arguments. */
  const logFailure = (cause: unknown, message: string): void => {
    options.logger?.error({ errName: (cause as Error | undefined)?.name }, message);
  };

  const error = (
    status: number,
    code: ErrorCode,
    message: string = MESSAGES[code],
    command?: CommandView,
  ): CommandResult => ({
    status,
    body: { error: { code, message }, ...(command === undefined ? {} : { command }) },
  });

  const stateOf = (projectId: string): ProjectState | undefined =>
    engine.storage.projection<ProjectState>(projectId)?.state;

  const viewOf = (command: Command): CommandView => {
    const result = results.get(command.id);
    return {
      id: command.id,
      type: command.type,
      requestId: command.requestId,
      status:
        (command.status === "requested" || command.status === "delivered") &&
        results.has(command.id)
          ? "succeeded"
          : command.status === "requested" && deliveredHere.has(command.id)
            ? "delivered"
            : command.status,
      ...(result === undefined ? {} : { result }),
    };
  };

  /** Appends one engine event; a refusal here is a bug, so it fails loudly instead of lying. */
  const record = (
    projectId: string,
    type: string,
    sourceEventId: string,
    payload: Record<string, unknown>,
    attribution?: Pick<PendingRequest, "agentId" | "sessionId">,
  ): void => {
    const stored = commitEngineEvent(commitOptions, {
      schemaVersion: 1,
      projectId,
      sourceId: ENGINE_SOURCE_ID,
      sourceEventId,
      occurredAt: now().toISOString(),
      evidenceIds: [],
      provenance: "live",
      late: false,
      type,
      payload,
      ...(attribution?.agentId === undefined ? {} : { agentId: attribution.agentId }),
      ...(attribution?.sessionId === undefined ? {} : { sessionId: attribution.sessionId }),
    });
    if (stored === undefined) throw new Error("A command event could not be recorded");
  };

  const requested = (
    body: CommandBody,
    commandId: string,
    payload: Record<string, unknown>,
  ): void => {
    record(body.projectId, "command.requested", `command.requested:${commandId}`, {
      commandId,
      commandType: body.type,
      requestId: body.requestId,
      payload,
      idempotencyKey: body.idempotencyKey,
    });
    commandProjects.set(commandId, body.projectId);
  };

  /** Ends a command that never reached its target: `failed`, `expired`, or `unsupported`. */
  const endWithout = (
    body: CommandBody,
    commandId: string,
    status: "failed" | "expired" | "unsupported",
    code: ErrorCode,
    httpStatus: number,
    message: string = MESSAGES[code],
  ): CommandResult => {
    record(
      body.projectId,
      `command.${status}`,
      `command.${status}:${commandId}`,
      status === "failed" ? { commandId, reason: message } : { commandId },
    );
    return error(httpStatus, code, message, {
      id: commandId,
      type: body.type,
      requestId: body.requestId,
      status,
    });
  };

  /** The command already recorded under this key: a replay of the same command, or a conflict. */
  const sameKey = (state: ProjectState, body: CommandBody): CommandResult | undefined => {
    const existing = Object.values(state.commands).find(
      (command) => command.idempotencyKey === body.idempotencyKey,
    );
    if (existing === undefined) return undefined;
    if (!isSameCommand(existing, body)) return error(409, "idempotency_conflict");
    // An opener this process is not running was cut short by an engine stop: end the command
    // instead of answering "in flight" forever. One that ran here and only failed to record its
    // outcome is remembered in `results` and replays as succeeded.
    if (
      (existing.status === "requested" || existing.status === "delivered") &&
      body.type === "session.open" &&
      !results.has(existing.id) &&
      !opening.has(`${body.projectId}\0${body.sessionId}`)
    ) {
      return endWithout(
        body,
        existing.id,
        "failed",
        "opener_failed",
        502,
        INTERRUPTED_OPENER_MESSAGE,
      );
    }
    return replay(existing);
  };

  const replay = (command: Command): CommandResult => {
    const view = viewOf(command);
    const failure = (status: number, code: ErrorCode, message?: string) =>
      error(status, code, message, view);
    if (command.type === "permission.decide") {
      switch (view.status) {
        case "delivered":
        case "succeeded":
          return { status: 200, body: { command: view } };
        case "failed":
          return failure(409, "request_not_open");
        case "expired":
          return failure(410, "request_expired");
        case "unsupported":
          return failure(422, "not_answerable");
        case "requested":
          return failure(409, "command_in_flight");
      }
    }
    switch (view.status) {
      case "succeeded":
        return { status: 200, body: { command: view } };
      case "failed":
        return failure(502, "opener_failed", command.reason?.text);
      default:
        return failure(409, "command_in_flight");
    }
  };

  const permissionDecide = (body: PermissionDecideBody): CommandResult => {
    const state = stateOf(body.projectId);
    if (state === undefined) return error(404, "unknown_project");
    const prior = sameKey(state, body);
    if (prior !== undefined) return prior;
    const request = Object.hasOwn(state.requests, body.requestId)
      ? state.requests[body.requestId]
      : undefined;
    if (request === undefined) return error(404, "unknown_request");

    const commandId = newId();
    requested(body, commandId, { decision: decisionIdentity(body.decision) });
    // The recorded state decides first, so a stale bridge entry cannot reopen a closed request.
    if (request.state !== "open") {
      return endWithout(body, commandId, "failed", "request_not_open", 409);
    }
    // Only a request the bridge held is answerable (elicitations and notifications are not).
    if (!request.answerable) {
      return endWithout(body, commandId, "unsupported", "not_answerable", 422);
    }
    // The bridge must hold this very request: another project's or session's hold with the same
    // ID must not receive the decision.
    const held = bridge.lookup(body.requestId);
    if (
      held === undefined ||
      held.projectId !== body.projectId ||
      held.sessionId !== request.sessionId
    ) {
      return endWithout(body, commandId, "expired", "request_expired", 410);
    }
    const decision: CommandBridgeDecision =
      body.decision.behavior === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: cleanNote(body.decision.message) ?? DEFAULT_DENY_MESSAGE };
    if (!bridge.decide(body.requestId, decision)) {
      return endWithout(body, commandId, "expired", "request_expired", 410);
    }
    // The hook response is answered; what follows only records it. "Sent, unconfirmed": never
    // command.succeeded here (decision #116 D4). A failed append cannot undo the answer, so it is
    // logged (by name only) and the command still reads as delivered, also on a retry.
    try {
      record(
        body.projectId,
        "request.resolved",
        `request.resolved:${body.requestId}:${commandId}`,
        {
          requestId: body.requestId,
          resolution: "answered_here",
          decision: body.decision.behavior,
        },
        request,
      );
    } catch (cause) {
      logFailure(cause, "recording the resolved request failed after the decision was sent");
    }
    try {
      record(body.projectId, "command.delivered", `command.delivered:${commandId}`, { commandId });
    } catch (cause) {
      deliveredHere.add(commandId);
      logFailure(cause, "recording the delivered command failed after the decision was sent");
    }
    return {
      status: 200,
      body: {
        command: {
          id: commandId,
          type: body.type,
          requestId: body.requestId,
          status: "delivered",
        } satisfies CommandView,
      },
    };
  };

  const sessionOpen = async (body: SessionOpenBody): Promise<CommandResult> => {
    const state = stateOf(body.projectId);
    if (state === undefined) return error(404, "unknown_project");
    const prior = sameKey(state, body);
    if (prior !== undefined) return prior;
    const session: Session | undefined = Object.hasOwn(state.sessions, body.sessionId)
      ? state.sessions[body.sessionId]
      : undefined;
    if (session === undefined) return error(404, "unknown_session");
    const request = Object.hasOwn(state.requests, body.requestId)
      ? state.requests[body.requestId]
      : undefined;
    if (request === undefined) return error(404, "unknown_request");

    // No await between the idempotency check above and claiming the session slot below (and
    // recording command.requested): two submits of the same key or session cannot both get past
    // them. Everything that awaits comes after the claim.
    const slot = `${body.projectId}\0${body.sessionId}`;
    if (opening.has(slot)) return error(409, "command_in_flight");
    opening.add(slot);
    try {
      const commandId = newId();
      requested(body, commandId, { sessionId: body.sessionId });
      if (request.state !== "open") {
        return endWithout(body, commandId, "failed", "request_not_open", 409);
      }
      if (request.sessionId !== body.sessionId) {
        return endWithout(body, commandId, "failed", "request_session_mismatch", 409);
      }
      // The working directory is the recorded one, never the request's. Telemetry recorded it, so
      // a directory the opener would receive must resolve inside one of the project's roots;
      // isDirectory keeps a file (such as an `x.command` script) from reaching the opener.
      const cwd = session.workingDirectory;
      let openerCwd = cwd ?? "";
      const template = opener.config.sessionOpener;
      if (cwd !== undefined && template?.some((arg) => arg.includes("{cwd}")) === true) {
        const resolved = await resolveOpenerCwd(body.projectId, cwd);
        if (resolved === undefined) {
          return endWithout(
            body,
            commandId,
            "failed",
            "opener_failed",
            502,
            OPENER_CWD_REFUSED_MESSAGE,
          );
        }
        openerCwd = resolved;
      }
      const outcome = await openSession(
        { sessionId: body.sessionId, cwd: openerCwd },
        {
          config: opener.config,
          execFile: opener.execFile,
          isDirectory: defaultIsDirectory,
        },
      ).catch((cause: unknown) => {
        logFailure(cause, "session opener threw");
        return {
          status: "failed" as const,
          message: "The session opener could not be started",
        };
      });
      if (outcome.status === "failed") {
        return endWithout(body, commandId, "failed", "opener_failed", 502, outcome.message);
      }
      const result: SessionOpenResult = {
        outcome: outcome.status,
        sessionId: body.sessionId,
        ...(cwd === undefined ? {} : { cwd }),
      };
      // The opener ran, so the session may be open: a failed append cannot undo that. The outcome
      // is kept in memory first, so the command reads as succeeded (also on a retry of the key)
      // even when the log could not be written; the error is logged by name only.
      remember(commandId, result);
      try {
        record(body.projectId, "command.delivered", `command.delivered:${commandId}`, {
          commandId,
        });
        record(body.projectId, "command.succeeded", `command.succeeded:${commandId}`, {
          commandId,
        });
      } catch (cause) {
        logFailure(cause, "recording the opened session failed after the opener ran");
      }
      return {
        status: 200,
        body: {
          command: {
            id: commandId,
            type: body.type,
            requestId: body.requestId,
            status: "succeeded",
            result,
          } satisfies CommandView,
        },
      };
    } finally {
      opening.delete(slot);
    }
  };

  const remember = (commandId: string, result: SessionOpenResult): void => {
    results.set(commandId, result);
    while (results.size > maxRememberedResults) {
      const [oldest] = results.keys();
      if (oldest === undefined) break;
      results.delete(oldest);
    }
  };

  /**
   * The recorded directory's real path, or undefined when it must not reach the opener: missing,
   * outside every root of the project (symlinks resolved on both sides), or named like something
   * macOS launches.
   */
  const resolveOpenerCwd = async (projectId: string, cwd: string): Promise<string | undefined> => {
    try {
      const real = await realpath(cwd);
      const name = real.slice(real.lastIndexOf(sep) + 1).toLowerCase();
      if (LAUNCHABLE_SUFFIXES.some((suffix) => name.endsWith(suffix))) return undefined;
      const roots = engine.storage.projects().find((project) => project.id === projectId)?.roots;
      for (const root of roots ?? []) {
        const realRoot = await realpath(root).catch(() => undefined);
        if (realRoot !== undefined && isInside(realRoot, real)) return real;
      }
    } catch {
      // A path that cannot be resolved is refused.
    }
    return undefined;
  };

  const findCommand = (commandId: string): Command | undefined => {
    const own = (state: ProjectState | undefined): Command | undefined =>
      state !== undefined && Object.hasOwn(state.commands, commandId)
        ? state.commands[commandId]
        : undefined;
    const known = commandProjects.get(commandId);
    if (known !== undefined) return own(stateOf(known));
    for (const project of engine.storage.projects()) {
      const found = own(stateOf(project.id));
      if (found !== undefined) return found;
    }
    return undefined;
  };

  // Commands cut short by an engine stop are ended now, so `GET` agrees with a repeated `POST`: a
  // session.open still `requested` or `delivered` (an opener runs only inside this process), and a
  // permission.decide still `requested` (its hook response did not survive the stop). A
  // permission.decide that is `delivered` stays: it was sent, and M4.04 confirms it. One that
  // cannot be ended is logged and skipped; it never stops the service from starting.
  try {
    for (const project of engine.storage.projects()) {
      for (const command of Object.values(stateOf(project.id)?.commands ?? {})) {
        const stale =
          command.type === "session.open"
            ? command.status === "requested" || command.status === "delivered"
            : command.status === "requested";
        if (!stale) continue;
        try {
          record(project.id, "command.failed", `command.failed:${command.id}`, {
            commandId: command.id,
            reason:
              command.type === "session.open"
                ? INTERRUPTED_OPENER_MESSAGE
                : INTERRUPTED_DECISION_MESSAGE,
          });
        } catch (cause) {
          logFailure(cause, "ending a command cut short by an engine stop failed");
        }
      }
    }
  } catch (cause) {
    logFailure(cause, "recovering commands cut short by an engine stop failed");
  }

  return {
    async submit(raw) {
      const parsed = commandBodySchema.safeParse(raw);
      if (!parsed.success) return error(400, "bad_request");
      const body = parsed.data;
      if (body.context?.mode === "history") return error(400, "history_context_rejected");
      return body.type === "permission.decide" ? permissionDecide(body) : sessionOpen(body);
    },
    get(commandId) {
      const command = findCommand(commandId);
      if (command === undefined) return error(404, "unknown_command");
      return { status: 200, body: { command: viewOf(command) } };
    },
  };
}

/** Whether a stored command is the one `body` asks for (same type, target, and choice). */
function isSameCommand(command: Command, body: CommandBody): boolean {
  if (command.type !== body.type || command.requestId !== body.requestId) return false;
  if (body.type === "session.open") return command.payload.sessionId === body.sessionId;
  const decision = command.payload.decision;
  if (typeof decision !== "object" || decision === null) return false;
  const stored = decision as { behavior?: unknown; noteDigest?: unknown };
  const wanted = decisionIdentity(body.decision);
  return stored.behavior === wanted.behavior && stored.noteDigest === wanted.noteDigest;
}

/**
 * What the log keeps of a decision: the behavior, and for a deny with a note only a digest of it,
 * so a retry that changes the note is a different command without the note being recorded.
 */
function decisionIdentity(decision: PermissionDecideBody["decision"]): {
  behavior: "allow" | "deny";
  noteDigest?: string;
} {
  const note = decision.behavior === "deny" ? cleanNote(decision.message) : undefined;
  if (note === undefined) return { behavior: decision.behavior };
  return { behavior: "deny", noteDigest: createHash("sha256").update(note).digest("hex") };
}

/**
 * The deny note as the agent should see it: control characters stripped except newline and tab,
 * and undefined when nothing but whitespace is left (a blank note counts as no note).
 */
function cleanNote(message: string | undefined): string | undefined {
  const note = message?.replace(NOTE_CONTROLS, "");
  return note === undefined || note.trim() === "" ? undefined : note;
}

/** Whether `path` is `root` or lies below it (both already resolved). */
function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel));
}
