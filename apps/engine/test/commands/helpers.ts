import { type EventType, type StoredEnvelope, storedEnvelopeSchemas } from "@taskville/protocol";
import pino, { type Logger } from "pino";
import { vi } from "vitest";
import {
  type CommandBridge,
  type CommandBridgeDecision,
  type CommandService,
  createCommandService,
  type HeldRequest,
  registerCommandRoutes,
} from "../../src/commands/index.ts";
import type { OpenSessionExecFile } from "../../src/commands/open-session.ts";
import { domainReducer } from "../../src/ingest/index.ts";
import { clientContentHash } from "../../src/storage/index.ts";
import { ORIGIN, postJson, sessionHeaders } from "../http/helpers.ts";
import { addProject, BASE, bootInProcess, type Engine, useDbPath } from "../stream/helpers.ts";

export { BRIDGE_TOKEN, bearer, CLI_TOKEN, ORIGIN, sessionHeaders } from "../http/helpers.ts";
export { BASE, type Engine, useDbPath };

// Contract pinned for M4.03 (apps/engine/src/commands/index.ts):
//
//   createCommandService({ engine, bridge, opener, now?, newId? }): CommandService
//     engine:  the object bootEngine returns (the service uses its storage, hub, and pipeline;
//              how it appends engine events is its own business, M4.02 owns the trusted path)
//     bridge:  CommandBridge = {
//                lookup(requestId): HeldRequest | undefined   // shape pinned by M4.02
//                decide(requestId, decision): boolean         // true only while the hold is open
//              }
//     opener:  { config: { sessionOpener: string[] | null }, execFile: OpenSessionExecFile }
//              (the service always passes isDirectory: defaultIsDirectory to openSession)
//   registerCommandRoutes(app, service): registers POST /v1/commands and GET /v1/commands/:id
//     with requireScope("command"), replacing the 501 stub in createApp.

export const PROJECT = "demo";
export const REQUEST_ID = "req-1";
export const SESSION_ID = "sess-1";
export const AGENT_ID = "agent-1";
const T0 = "2026-10-30T12:00:00.000Z";

export interface FakeBridge extends CommandBridge {
  lookup: ReturnType<typeof vi.fn<(requestId: string) => HeldRequest | undefined>>;
  decide: ReturnType<typeof vi.fn<(requestId: string, decision: CommandBridgeDecision) => boolean>>;
  /** Starts holding a request, as the bridge does while a hook response is open. */
  hold(requestId?: string): void;
  /** Drops the held request without a decision, as the bridge does when the hold window ends. */
  fallThrough(requestId: string): void;
}

/** A bridge whose `decide` is true once per held request, then false (like a closed hook response). */
export function fakeBridge(): FakeBridge {
  const held = new Map<string, HeldRequest>();
  const lookup = vi.fn((requestId: string) => held.get(requestId));
  const decide = vi.fn((requestId: string, _decision: CommandBridgeDecision) =>
    held.delete(requestId),
  );
  return {
    lookup,
    decide,
    hold: (requestId = REQUEST_ID) => {
      held.set(requestId, {
        requestId,
        projectId: PROJECT,
        sessionId: SESSION_ID,
        toolName: "Bash",
        toolInput: { command: "ls" },
      });
    },
    fallThrough: (requestId) => {
      held.delete(requestId);
    },
  };
}

export interface SeedEvent {
  type: EventType;
  payload: Record<string, unknown>;
  sourceId?: string;
  agentId?: string;
  sessionId?: string;
}

/**
 * Appends events straight to storage and applies them to the projection, as `expireOpenRequests`
 * does. Needed because the ingest route refuses the `taskville:bridge` source that makes a request
 * answerable. Seed before any ingest call so the pipeline's projection cache is not stale.
 */
export function seedEvents(engine: Engine, projectId: string, events: SeedEvent[]): void {
  engine.storage.transaction((tx) => {
    let sequence = tx.head(projectId) ?? 0;
    const stored = tx.projection(projectId);
    let state =
      stored === undefined
        ? domainReducer.initial(projectId)
        : (stored.state as ReturnType<typeof domainReducer.initial>);
    for (const event of events) {
      sequence += 1;
      const envelope = storedEnvelopeSchemas[event.type].parse({
        schemaVersion: 1,
        eventId: `00000000-0000-4000-8000-${(1000 + sequence).toString(16).padStart(12, "0")}`,
        projectId,
        sourceId: event.sourceId ?? "claude-code",
        sourceEventId: `seed-${sequence}`,
        occurredAt: T0,
        receivedAt: T0,
        ingestSequence: sequence,
        type: event.type,
        payload: event.payload,
        evidenceIds: [],
        provenance: "live",
        late: false,
        ...(event.agentId === undefined ? {} : { agentId: event.agentId }),
        ...(event.sessionId === undefined ? {} : { sessionId: event.sessionId }),
      }) as StoredEnvelope;
      tx.appendEvent(envelope, clientContentHash(envelope));
      state = domainReducer.apply(state, envelope);
    }
    tx.writeProjection({
      projectId,
      reducerVersion: domainReducer.version,
      head: sequence,
      state,
    });
  });
}

export function sessionStarted(
  cwd: string | undefined,
  sessionId: string = SESSION_ID,
  agentId: string = AGENT_ID,
): SeedEvent {
  return {
    type: "session.started",
    payload: cwd === undefined ? {} : { workingDirectory: cwd },
    agentId,
    sessionId,
  };
}

export function requestOpened(options: {
  requestId?: string;
  sourceId?: string;
  kind?: "permission" | "elicitation" | "input";
  sessionId?: string;
  agentId?: string;
}): SeedEvent {
  return {
    type: "request.opened",
    payload: {
      requestId: options.requestId ?? REQUEST_ID,
      kind: options.kind ?? "permission",
      toolName: "Bash",
      inputPreview: "ls",
    },
    sourceId: options.sourceId ?? "taskville:bridge",
    agentId: options.agentId ?? AGENT_ID,
    sessionId: options.sessionId ?? SESSION_ID,
  };
}

export interface Harness {
  app: ReturnType<typeof bootInProcess>["app"];
  engine: Engine;
  service: CommandService;
  bridge: FakeBridge;
  execFile: ReturnType<typeof vi.fn<OpenSessionExecFile>>;
  /** A paired browser session secret. */
  session: string;
  /** POST /v1/commands as the paired browser (session header and matching Origin). */
  post(body: unknown, headers?: Record<string, string>): Promise<Response>;
  get(id: string, headers?: Record<string, string>): Promise<Response>;
}

export interface HarnessOptions {
  sessionOpener?: string[] | null;
  execFile?: OpenSessionExecFile;
  /** Events seeded into the `demo` project before the service starts. */
  seed?: SeedEvent[];
  holdBridgeRequest?: boolean;
  /** The project's configured roots (project.created); the opener cwd must lie inside one. */
  roots?: string[];
  /** Passed to the command service, so a test can read what it logs. */
  logger?: Logger;
  /**
   * Extra `createCommandService` options for names pinned by a test but not yet in the type
   * (such as `maxRememberedResults`). Spread into the options object.
   */
  serviceExtras?: Record<string, unknown>;
}

/** A logger whose lines are collected as strings, like `makeApp` does for the access log. */
export function capturingLogger(): { logger: Logger; lines: string[] } {
  const lines: string[] = [];
  const logger = pino({ level: "debug" }, { write: (line: string) => lines.push(line) });
  return { logger, lines };
}

/**
 * Makes the next `times` appends of `eventType` through `storage.transaction` throw an error
 * named `errName` (message `errMessage`); every other append goes through. Returns a restore
 * function. This is the storage/append seam: the service's own `record` goes through it.
 */
export function failAppend(
  storage: Engine["storage"],
  eventType: string,
  options: { times?: number; errName?: string; errMessage?: string } = {},
): () => void {
  let remaining = options.times ?? 1;
  const real = storage.transaction.bind(storage);
  const spy = vi.spyOn(storage, "transaction").mockImplementation(((
    fn: (tx: Parameters<Parameters<typeof real>[0]>[0]) => unknown,
  ) =>
    real((tx) =>
      fn({
        ...tx,
        appendEvent: (envelope, hash) => {
          if (envelope.type === eventType && remaining > 0) {
            remaining -= 1;
            throw Object.assign(new Error(options.errMessage ?? "append refused"), {
              name: options.errName ?? "InjectedAppendError",
            });
          }
          return tx.appendEvent(envelope, hash);
        },
      }),
    )) as never);
  return () => spy.mockRestore();
}

/**
 * Stops the engine in `h` and starts a new one on the same database, as a restart does, then
 * creates a new command service on it. `beforeService` runs between the boot and the service,
 * for a test that must break something the service touches while it starts.
 */
export function restartService(
  h: Harness,
  dbPath: string,
  options: {
    sessionOpener?: string[] | null;
    logger?: Logger;
    beforeService?: (engine: Engine) => void;
  } = {},
) {
  h.engine.close();
  const booted = bootInProcess(dbPath);
  options.beforeService?.(booted.engine);
  const execFile = vi.fn<OpenSessionExecFile>(async () => undefined);
  const decide = vi.fn(() => false);
  const service = createCommandService({
    engine: booted.engine,
    bridge: { lookup: () => undefined, decide },
    opener: { config: { sessionOpener: options.sessionOpener ?? null }, execFile },
    ...(options.logger === undefined ? {} : { logger: options.logger }),
  });
  registerCommandRoutes(booted.app, service);
  const session = booted.pairing.exchange(booted.pairing.issueCode()) ?? "";
  return {
    engine: booted.engine,
    execFile,
    decide,
    post: (body: unknown) =>
      Promise.resolve(
        booted.app.request(
          `${BASE}/v1/commands`,
          postJson(body, { ...sessionHeaders(session), Origin: ORIGIN }),
        ),
      ),
    get: (id: string) =>
      Promise.resolve(
        booted.app.request(`${BASE}/v1/commands/${id}`, { headers: sessionHeaders(session) }),
      ),
  };
}

/** Boots an in-process engine with project `demo`, registers the command routes, pairs a browser. */
export function bootHarness(dbPath: string, options: HarnessOptions = {}): Harness {
  const booted = bootInProcess(dbPath, { now: () => new Date(T0) });
  const { app, engine, pairing } = booted;
  addProject(engine.storage, PROJECT, options.roots ?? []);
  seedEvents(engine, PROJECT, options.seed ?? [requestOpened({})]);
  const bridge = fakeBridge();
  if (options.holdBridgeRequest ?? true) bridge.hold();
  const execFile = vi.fn<OpenSessionExecFile>(options.execFile ?? (async () => undefined));
  const service = createCommandService({
    engine,
    bridge,
    opener: { config: { sessionOpener: options.sessionOpener ?? null }, execFile },
    now: () => new Date(T0),
    ...(options.logger === undefined ? {} : { logger: options.logger }),
    ...options.serviceExtras,
  });
  registerCommandRoutes(app, service);
  const session = pairing.exchange(pairing.issueCode()) ?? "";
  return {
    app,
    engine,
    service,
    bridge,
    execFile,
    session,
    post: (body, headers = {}) =>
      Promise.resolve(
        app.request(
          `${BASE}/v1/commands`,
          postJson(body, { ...sessionHeaders(session), Origin: ORIGIN, ...headers }),
        ),
      ),
    get: (id, headers = {}) =>
      Promise.resolve(
        app.request(`${BASE}/v1/commands/${id}`, {
          headers: { ...sessionHeaders(session), ...headers },
        }),
      ),
  };
}

export function decideBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "permission.decide",
    projectId: PROJECT,
    requestId: REQUEST_ID,
    idempotencyKey: "key-1",
    decision: { behavior: "allow" },
    ...overrides,
  };
}

export function openBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    type: "session.open",
    projectId: PROJECT,
    sessionId: SESSION_ID,
    requestId: REQUEST_ID,
    idempotencyKey: "open-1",
    ...overrides,
  };
}

export interface LoggedEvent {
  type: string;
  sourceId: string;
  payload: Record<string, unknown>;
}

/** The command.* events and the engine's request.resolved / request.expired, in log order. */
export function commandEvents(engine: Engine, projectId = PROJECT): LoggedEvent[] {
  return [...engine.storage.events(projectId)]
    .filter((e) => e.type.startsWith("command.") || /^request\.(resolved|expired)$/.test(e.type))
    .map((e) => ({
      type: e.type,
      sourceId: e.sourceId,
      payload: e.payload as Record<string, unknown>,
    }));
}

export const types = (events: LoggedEvent[]): string[] => events.map((e) => e.type);

export interface CommandView {
  id: string;
  type: string;
  requestId: string;
  status: string;
  result?: { outcome: string; sessionId: string; cwd: string };
}

export interface CommandResponse {
  command?: CommandView;
  error?: { code: string; message: string };
}

export async function json(res: Response): Promise<CommandResponse> {
  return (await res.json()) as CommandResponse;
}
