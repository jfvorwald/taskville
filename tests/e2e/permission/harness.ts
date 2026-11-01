// Shared pieces of the M4.10 permission end-to-end run: a real `taskville serve --headless` in a
// throwaway home with a short hold window, the recorded S-1 PermissionRequest payload adapted to a
// throwaway project folder, and a fake Claude Code hook client that holds the connection open.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { Database } from "../../../apps/engine/src/storage/sqlite.ts";

export const REPO = resolve(import.meta.dirname, "../../..");
export const CLI_MAIN = join(REPO, "apps/cli/src/main.ts");
export const FIXTURES = join(REPO, "fixtures/claude-code/permission");
export const HOOK_PATH = "/v1/bridge/claude-code/permission";
export const TELEMETRY_PATH = "/v1/sources/claude-code/hooks";

/**
 * A project folder no registered project covers, so the engine routes the session to the built-in
 * `unsorted` project, which is the one the web client shows until the viewer picks another.
 */
export const PROJECT_ID = "unsorted";

/** The hold window the replay runs with (config.json `bridge.holdWindowSeconds`). */
export const HOLD_WINDOW_SECONDS = 3;

function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export interface PermissionEngine {
  url: string;
  home: string;
  /** The folder the fake Claude Code session reports as its `cwd`. */
  cwd: string;
  /** The single-use pairing code `serve` printed. */
  pairingCode: string;
  cliToken: string;
  bridgeToken: string;
  child: ChildProcess;
  log(): string;
  stop(): Promise<void>;
}

/** Starts `taskville serve --headless` with a short hold window and waits for its pairing URL. */
export async function startPermissionEngine(
  holdWindowSeconds = HOLD_WINDOW_SECONDS,
  options: { root?: string; keepRoot?: boolean } = {},
): Promise<PermissionEngine> {
  const root = options.root ?? mkdtempSync(join(tmpdir(), "taskville-permission-e2e-"));
  const home = join(root, "home");
  const cwd = join(root, "proj");
  mkdirSync(home, { recursive: true, mode: 0o700 });
  mkdirSync(cwd, { recursive: true });
  writeFileSync(join(home, "config.json"), JSON.stringify({ bridge: { holdWindowSeconds } }), {
    mode: 0o600,
  });
  const port = await freePort();
  const child = spawn(
    process.execPath,
    [CLI_MAIN, "serve", "--headless", "--home", home, "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: root },
    },
  );
  let out = "";
  let err = "";
  child.stdout?.on("data", (c: Buffer) => {
    out += c.toString("utf8");
  });
  child.stderr?.on("data", (c: Buffer) => {
    err += c.toString("utf8");
  });
  const exited = new Promise<void>((done) => child.once("exit", () => done()));
  await new Promise<void>((done, fail) => {
    const timer = setTimeout(
      () => fail(new Error(`engine did not start:\n${out}\n${err}`)),
      20_000,
    );
    const check = () => {
      if (/#pair=[A-Za-z0-9_-]+/.test(out)) {
        clearTimeout(timer);
        done();
      }
    };
    child.stdout?.on("data", check);
    child.once("exit", (code) => {
      clearTimeout(timer);
      fail(new Error(`engine exited ${code}:\n${err}`));
    });
  });
  const pairingCode = /#pair=([A-Za-z0-9_-]+)/.exec(out)?.[1] ?? "";
  return {
    url: `http://127.0.0.1:${port}`,
    home,
    cwd,
    pairingCode,
    cliToken: readFileSync(join(home, "token"), "utf8").trim(),
    bridgeToken: readFileSync(join(home, "bridge-token"), "utf8").trim(),
    child,
    log: () => err,
    stop: async () => {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill("SIGTERM");
        await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
      }
      if (options.keepRoot !== true) rmSync(root, { recursive: true, force: true });
    },
  };
}

/** The recorded S-1 PermissionRequest body, with `cwd` pointed at the throwaway project. */
export function recordedPermissionRequest(cwd: string): Record<string, unknown> {
  const fixture = JSON.parse(readFileSync(join(FIXTURES, "permission-request.json"), "utf8")) as {
    body: Record<string, unknown>;
  };
  return {
    ...fixture.body,
    cwd,
    transcript_path: join(cwd, "transcript.jsonl"),
    permission_suggestions: [],
  };
}

/** The hook JSON Claude Code receives for an allow, from the recording. */
export function recordedAllowBody(): unknown {
  return (
    JSON.parse(readFileSync(join(FIXTURES, "response-allow.json"), "utf8")) as { body: unknown }
  ).body;
}

/** The hook JSON for a deny with `message`, shaped like the recording. */
export function denyBodyWith(message: string): unknown {
  const body = (
    JSON.parse(readFileSync(join(FIXTURES, "response-deny.json"), "utf8")) as {
      body: { hookSpecificOutput: { decision: Record<string, unknown> } };
    }
  ).body;
  body.hookSpecificOutput.decision.message = message;
  return body;
}

/** SessionStart as Claude Code sends it, posted through the telemetry route (CLI token). */
export async function registerSession(engine: PermissionEngine, sessionId: string): Promise<void> {
  const res = await fetch(`${engine.url}${TELEMETRY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${engine.cliToken}` },
    body: JSON.stringify({
      sourceEventId: `00000000-0000-4000-8000-${"1".padStart(12, "0")}`,
      payload: {
        session_id: sessionId,
        transcript_path: join(engine.cwd, "transcript.jsonl"),
        cwd: engine.cwd,
        hook_event_name: "SessionStart",
        source: "startup",
      },
    }),
  });
  if (res.status >= 300) throw new Error(`SessionStart refused: ${res.status} ${await res.text()}`);
}

/** The agent ID the engine gives a Claude Code session. */
export const agentIdOf = (sessionId: string): string => `claude-code:${sessionId}`;

export interface HookAnswer {
  status: number;
  text: string;
  /** Parsed body, or undefined for the empty fall-through. */
  json: unknown;
  elapsedMs: number;
}

export interface HeldHook {
  /** Settles when the engine answers the held connection. */
  answer: Promise<HookAnswer>;
  /** Closes the connection as Claude Code does when the user answers in the terminal. */
  abort(): void;
}

/**
 * Acts as Claude Code: POSTs the PermissionRequest hook with the bridge token and keeps the
 * connection open until the engine answers. It never retries.
 */
export function holdHook(engine: PermissionEngine, body: Record<string, unknown>): HeldHook {
  const controller = new AbortController();
  const started = performance.now();
  const answer = fetch(`${engine.url}${HOOK_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${engine.bridgeToken}` },
    body: JSON.stringify(body),
    signal: controller.signal,
  }).then(async (res) => {
    const text = await res.text();
    return {
      status: res.status,
      text,
      json: text === "" ? undefined : (JSON.parse(text) as unknown),
      elapsedMs: performance.now() - started,
    };
  });
  // A test that never reads the answer must not crash the run on a closed connection.
  answer.catch(() => {});
  return { answer, abort: () => controller.abort() };
}

export interface LoggedEvent {
  ingestSequence: number;
  type: string;
  sourceId: string;
  agentId?: string;
  payload: Record<string, unknown>;
}

/** The unsorted project's event log, read only, straight from `taskville.db` (WAL, safe while serving). */
export function logEvents(home: string, projectId = PROJECT_ID): LoggedEvent[] {
  const db = new Database(join(home, "taskville.db"), { readOnly: true });
  try {
    const rows = db
      .prepare("SELECT envelope_json FROM events WHERE project_id = ? ORDER BY ingest_sequence")
      .all(projectId) as { envelope_json: string }[];
    return rows.map((r) => JSON.parse(r.envelope_json) as LoggedEvent);
  } finally {
    db.close();
  }
}

export const eventsOfType = (home: string, type: string): LoggedEvent[] =>
  logEvents(home).filter((e) => e.type === type);
