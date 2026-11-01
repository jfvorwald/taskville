import type { ProjectState } from "@taskville/domain/reducer";
import type { StoredEnvelope } from "@taskville/protocol";
import type { PairingStore } from "../../src/auth/pairing.ts";
import {
  BRIDGE_PERMISSION_PATH,
  createPermissionBridge,
  type PermissionBridge,
  type PermissionBridgeOptions,
  registerBridgeRoutes,
} from "../../src/bridge/index.ts";
import { createProject } from "../../src/projects/index.ts";
import type { Storage } from "../../src/storage/index.ts";
import type { Engine } from "../../src/stream/index.ts";
import { BRIDGE_TOKEN, bearer, HOST, ORIGIN } from "../http/helpers.ts";
import { fixedNow, T0 } from "../ingest/helpers.ts";
import { bootInProcess, input, useDbPath } from "../stream/helpers.ts";

export { fakeGithubToken } from "../ingest/helpers.ts";
export { BRIDGE_PERMISSION_PATH, BRIDGE_TOKEN, bearer, HOST, ORIGIN, useDbPath };

export const PROJECT = "demo";
export const CWD = "/tmp/spike-s1/proj";
export const SESSION = "eaff5d10-daac-4e32-b35f-87f91ca81c8f";
export const AGENT = `claude-code:${SESSION}`;
export const BASE = "http://127.0.0.1:4807";
export const HOLD_MS = 90_000;
export { T0 };

/** The exact hook JSON Claude Code accepts (docs/spikes/S-1, fixtures/claude-code/permission). */
export const ALLOW_BODY = {
  hookSpecificOutput: { hookEventName: "PermissionRequest", decision: { behavior: "allow" } },
};
export const denyBody = (message: string) => ({
  hookSpecificOutput: {
    hookEventName: "PermissionRequest",
    decision: { behavior: "deny", message },
  },
});

/**
 * A manual stand-in for the bridge's `schedule` option, so no test waits for the 90 s hold.
 * `schedule(run, delayMs)` returns a cancel function; `advance(ms)` runs what came due.
 */
export class ManualScheduler {
  now = 0;
  readonly delays: number[] = [];
  readonly #tasks = new Map<number, { at: number; run: () => void }>();
  #next = 1;

  readonly schedule = (run: () => void, delayMs: number): (() => void) => {
    const id = this.#next++;
    this.delays.push(delayMs);
    this.#tasks.set(id, { at: this.now + delayMs, run });
    return () => {
      this.#tasks.delete(id);
    };
  };

  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      const due = [...this.#tasks.entries()]
        .filter(([, task]) => task.at <= this.now)
        .sort(([, a], [, b]) => a.at - b.at)[0];
      if (due === undefined) return;
      this.#tasks.delete(due[0]);
      due[1].run();
    }
  }

  get pending(): number {
    return this.#tasks.size;
  }
}

/** The raw PermissionRequest hook body (S-1 permission-request.json). */
export function permissionHook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION,
    transcript_path: `/Users/dev/.claude/projects/-tmp-proj/${SESSION}.jsonl`,
    cwd: CWD,
    prompt_id: "03dc4896-8835-47f5-a515-94a1ad4c675c",
    permission_mode: "default",
    hook_event_name: "PermissionRequest",
    tool_name: "Bash",
    tool_input: { command: "touch exp1.txt", description: "Create empty file exp1.txt" },
    permission_suggestions: [],
    ...overrides,
  };
}

/** The raw PostToolUse hook body for the same call (S-1 post-tool-use-after-terminal-allow.json). */
export function postToolUseHook(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    session_id: SESSION,
    cwd: CWD,
    prompt_id: "03dc4896-8835-47f5-a515-94a1ad4c675c",
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

export function postPermission(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  body: unknown,
  headers: Record<string, string> = bearer(BRIDGE_TOKEN),
  extra: RequestInit = {},
): Promise<Response> {
  return Promise.resolve(
    app.request(`${BASE}${BRIDGE_PERMISSION_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
      ...extra,
    }),
  );
}

export interface BridgeHarness {
  app: ReturnType<typeof bootInProcess>["app"];
  engine: Engine;
  bridge: PermissionBridge;
  scheduler: ManualScheduler;
  /** Events the connected viewer's stream received. */
  seen: StoredEnvelope[];
  /** Connects a viewer (a hub subscriber) to PROJECT; returns a disconnect function. */
  connectViewer(): () => void;
}

/**
 * Wires the permission bridge onto an already booted engine and app: project `demo` rooted at
 * CWD, the bridge routes on the app, and a registered Claude Code session agent. No viewer is
 * connected until the test calls `connectViewer()`.
 */
export function wireBridge(
  app: BridgeHarness["app"],
  engine: Engine,
  options: Partial<PermissionBridgeOptions> = {},
): BridgeHarness {
  if (engine.storage.project(PROJECT) === undefined) {
    createProject(engine.storage, { id: PROJECT, name: PROJECT, roots: [CWD] }, { now: fixedNow });
  }
  const scheduler = new ManualScheduler();
  const bridge = createPermissionBridge({
    storage: engine.storage,
    hub: engine.hub,
    schedule: scheduler.schedule,
    ...options,
  });
  registerBridgeRoutes(app, bridge);
  engine.pipeline.ingest([
    input("agent-1", {
      type: "agent.registered",
      agentId: AGENT,
      sessionId: SESSION,
      sourceId: "claude-code",
      payload: { sourceAgentId: SESSION, displayName: "proj", role: "main", kind: "session" },
    }),
  ]);
  const seen: StoredEnvelope[] = [];
  return {
    app,
    engine,
    bridge,
    scheduler,
    seen,
    connectViewer: () =>
      engine.hub.subscribe(PROJECT, { offer: (event) => seen.push(event), end: () => {} }),
  };
}

/** Boots an in-process engine (no socket) and wires the bridge onto it. Synchronous. */
export function bootBridge(
  dbPath: string,
  options: Partial<PermissionBridgeOptions> = {},
): BridgeHarness & { pairing: PairingStore } {
  const { app, engine, pairing } = bootInProcess(dbPath);
  return { ...wireBridge(app, engine, options), pairing };
}

export function projectState(engine: Engine, projectId = PROJECT): ProjectState {
  const projection = engine.storage.projection<ProjectState>(projectId);
  if (!projection) throw new Error("no projection");
  return projection.state;
}

export function requestsOf(engine: Engine) {
  return Object.values(projectState(engine).requests);
}

export function eventsOf(engine: Engine, type?: string): StoredEnvelope[] {
  const all = [...engine.storage.events(PROJECT)];
  return type === undefined ? all : all.filter((event) => event.type === type);
}

/** Polls until `check` stops throwing; the held response and the commit path are asynchronous. */
export async function eventually<T>(check: () => T, timeoutMs = 2000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    try {
      return check();
    } catch (error) {
      if (Date.now() > deadline) throw error;
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }
}

/** Waits for the bridge to hold exactly one request, and returns its ID. */
export function heldRequestId(engine: Engine): Promise<string> {
  return eventually(() => {
    const open = requestsOf(engine).filter((r) => r.answerable && r.state === "open");
    const [only] = open;
    if (open.length !== 1 || only === undefined) {
      throw new Error(`expected one open answerable request, got ${open.length}`);
    }
    return only.id;
  });
}

/**
 * Storage whose `transaction` throws while `state.fail` is true, to stand in for a disk error
 * (full disk, locked database) at the moment the bridge records an outcome. Reads still work.
 * While `state.stub` is true, `transaction` appends nothing and answers as if it had committed.
 */
export function failableStorage(storage: Storage): {
  storage: Storage;
  state: { fail: boolean; stub: boolean };
} {
  const state = { fail: false, stub: false };
  const proxy = new Proxy(storage, {
    get(target, prop) {
      if (prop === "transaction" && state.fail) {
        return () => {
          throw new Error("SQLITE_FULL: database or disk is full");
        };
      }
      if (prop === "transaction" && state.stub) {
        // Appends nothing: a cheap "committed" answer, for tests that drive thousands of requests.
        return () => ({ projectId: PROJECT, ingestSequence: 1 });
      }
      const value = Reflect.get(target, prop, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return { storage: proxy, state };
}

/** Like `bootBridge`, but the bridge's storage can be made to fail on demand (`state.fail`). */
export function bootFailingBridge(
  dbPath: string,
  options: Partial<PermissionBridgeOptions> = {},
): BridgeHarness & { state: { fail: boolean; stub: boolean } } {
  const { app, engine } = bootInProcess(dbPath);
  const failing = failableStorage(engine.storage);
  return {
    ...wireBridge(app, engine, { storage: failing.storage, ...options }),
    state: failing.state,
  };
}

/** An abort signal the test fires by hand, so the abort listener runs inside the test's call. */
export function manualSignal(): { signal: AbortSignal; abort: () => void } {
  let listener: (() => void) | undefined;
  let aborted = false;
  const signal = {
    get aborted() {
      return aborted;
    },
    addEventListener: (_type: string, fn: () => void) => {
      listener = fn;
    },
    removeEventListener: (_type: string, fn: () => void) => {
      if (listener === fn) listener = undefined;
    },
  } as unknown as AbortSignal;
  return {
    signal,
    abort: () => {
      aborted = true;
      const fn = listener;
      listener = undefined;
      fn?.();
    },
  };
}

/** Rejects when `promise` has not settled after `ms`: a hold that should not happen fails fast. */
export function within<T>(promise: Promise<T>, ms = 500): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`still pending after ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}
