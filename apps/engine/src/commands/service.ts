import { createHash, randomUUID } from "node:crypto";
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

const INTERRUPTED_OPENER_MESSAGE = "The session opener was interrupted by an engine stop";

/** Session results kept for replaying an idempotent session.open (oldest forgotten first). */
const MAX_REMEMBERED_RESULTS = 500;

type ErrorCode =
  | "bad_request"
  | "command_in_flight"
  | "history_context_rejected"
  | "idempotency_conflict"
  | "not_answerable"
  | "opener_failed"
  | "request_expired"
  | "request_not_open"
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
  unknown_command: "No such command",
  unknown_project: "No such project",
  unknown_request: "No such request",
  unknown_session: "No such session",
};

export function createCommandService(options: CommandServiceOptions): CommandService {
  const { engine, bridge, opener } = options;
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
  /** Which project a command belongs to; unknown IDs fall back to scanning the projections. */
  const commandProjects = new Map<string, string>();

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
      status: command.status,
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
    // instead of answering "in flight" forever.
    if (
      existing.status === "requested" &&
      body.type === "session.open" &&
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
      switch (command.status) {
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
    switch (command.status) {
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
    if (bridge.lookup(body.requestId) === undefined) {
      return endWithout(body, commandId, "expired", "request_expired", 410);
    }
    const decision: CommandBridgeDecision =
      body.decision.behavior === "allow"
        ? { behavior: "allow" }
        : { behavior: "deny", message: body.decision.message ?? DEFAULT_DENY_MESSAGE };
    if (!bridge.decide(body.requestId, decision)) {
      return endWithout(body, commandId, "expired", "request_expired", 410);
    }
    // The hook response is answered; what follows only records it. "Sent, unconfirmed": never
    // command.succeeded here (decision #116 D4).
    record(
      body.projectId,
      "request.resolved",
      `request.resolved:${body.requestId}:${commandId}`,
      { requestId: body.requestId, resolution: "answered_here", decision: body.decision.behavior },
      request,
    );
    record(body.projectId, "command.delivered", `command.delivered:${commandId}`, { commandId });
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

    const slot = `${body.projectId}\0${body.sessionId}`;
    if (opening.has(slot)) return error(409, "command_in_flight");
    opening.add(slot);
    try {
      const commandId = newId();
      requested(body, commandId, { sessionId: body.sessionId });
      // The working directory is the recorded one, never the request's; isDirectory keeps a file
      // (such as an `x.command` script) from reaching the opener.
      const cwd = session.workingDirectory;
      const outcome = await openSession(
        { sessionId: body.sessionId, cwd: cwd ?? "" },
        {
          config: opener.config,
          execFile: opener.execFile,
          isDirectory: defaultIsDirectory,
        },
      ).catch((cause: unknown) => {
        // Only the name is logged: an error message can carry the arguments and the path.
        options.logger?.error(
          { errName: (cause as Error | undefined)?.name },
          "session opener threw",
        );
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
      record(body.projectId, "command.delivered", `command.delivered:${commandId}`, {
        commandId,
      });
      record(body.projectId, "command.succeeded", `command.succeeded:${commandId}`, {
        commandId,
      });
      remember(commandId, result);
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
    if (results.size > MAX_REMEMBERED_RESULTS) {
      const [oldest] = results.keys();
      if (oldest !== undefined) results.delete(oldest);
    }
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

  // A session.open still `requested` when the service starts was cut short by an engine stop (an
  // opener runs only inside this process), so end it now and `GET` agrees with a repeated `POST`.
  for (const project of engine.storage.projects()) {
    for (const command of Object.values(stateOf(project.id)?.commands ?? {})) {
      if (command.type !== "session.open" || command.status !== "requested") continue;
      record(project.id, "command.failed", `command.failed:${command.id}`, {
        commandId: command.id,
        reason: INTERRUPTED_OPENER_MESSAGE,
      });
    }
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
  if (decision.behavior === "allow" || decision.message === undefined) {
    return { behavior: decision.behavior };
  }
  return {
    behavior: "deny",
    noteDigest: createHash("sha256").update(decision.message).digest("hex"),
  };
}
