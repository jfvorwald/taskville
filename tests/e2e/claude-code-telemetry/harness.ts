// Shared pieces of the Claude Code telemetry end-to-end run (M2.10): the real engine
// (`taskville serve --headless`) as a child process, the real CLI, the real shim, and snapshot
// reads over HTTP with the CLI token.

import { type ChildProcess, execFile, spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { Database } from "../../../apps/engine/src/storage/sqlite.ts";

export const REPO = resolve(import.meta.dirname, "../../..");
export const CLI_MAIN = join(REPO, "apps/cli/src/main.ts");
export const SHIM = join(REPO, "apps/cli/hooks/claude-code-shim.sh");
const run = promisify(execFile);

export function freePort(): Promise<number> {
  return new Promise((done, fail) => {
    const srv = createServer();
    srv.once("error", fail);
    srv.listen(0, "127.0.0.1", () => {
      const address = srv.address();
      srv.close(() => done(typeof address === "object" && address ? address.port : 0));
    });
  });
}

export interface Engine {
  url: string;
  port: number;
  home: string;
  child: ChildProcess;
  /** Everything the engine wrote to stderr (pino JSON lines). */
  log(): string;
  /** SIGTERM, then wait for exit (bounded). */
  stop(): Promise<void>;
  /** SIGKILL: the engine dies mid-session with no shutdown. */
  kill(): Promise<void>;
}

/** Starts `taskville serve --headless` and resolves once it printed its pairing URL. */
export async function startEngine(home: string, port: number): Promise<Engine> {
  const child = spawn(
    process.execPath,
    [CLI_MAIN, "serve", "--headless", "--home", home, "--port", String(port)],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: { PATH: process.env.PATH ?? "/usr/bin:/bin", HOME: home },
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
      if (out.includes("#pair=")) {
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
  const end = async (signal: NodeJS.Signals) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.kill(signal);
    await Promise.race([exited, new Promise((r) => setTimeout(r, 10_000))]);
  };
  return {
    url: `http://127.0.0.1:${port}`,
    port,
    home,
    child,
    log: () => err,
    stop: () => end("SIGTERM"),
    kill: () => end("SIGKILL"),
  };
}

export function token(home: string): string {
  return readFileSync(join(home, "token"), "utf8").trim();
}

/** Runs the real CLI; never throws on a non-zero exit. */
export async function cli(
  args: string[],
): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await run(process.execPath, [CLI_MAIN, ...args], {
      maxBuffer: 64 << 20,
    });
    return { code: 0, stdout, stderr };
  } catch (error) {
    const e = error as { code?: number; stdout?: string; stderr?: string };
    return {
      code: typeof e.code === "number" ? e.code : 1,
      stdout: e.stdout ?? "",
      stderr: e.stderr ?? "",
    };
  }
}

export interface SnapshotAgent {
  id: string;
  kind: string;
  displayName?: string;
  parentAgentId?: string;
  teamId?: string;
  finishedAt?: string;
  connection?: string;
}

export interface Snapshot {
  cursor: number;
  state: {
    agents: Record<string, SnapshotAgent>;
    toolCalls: Record<
      string,
      { id: string; agentId: string; toolName?: string; phase: string; evidenceIds: string[] }
    >;
    requests: Record<string, { late: boolean; state: string }>;
    teams: Record<string, { id: string; leadAgentId: string; memberAgentIds: string[] }>;
    tasks: Record<string, { id: string; title?: string; status: string }>;
  };
  attention: { agentId: string; level: string }[];
}

export async function snapshot(
  engine: Pick<Engine, "url" | "home">,
  projectId: string,
): Promise<Snapshot> {
  const res = await fetch(`${engine.url}/v1/projects/${projectId}/snapshot`, {
    headers: { Authorization: `Bearer ${token(engine.home)}` },
  });
  if (res.status !== 200) throw new Error(`snapshot ${res.status}: ${await res.text()}`);
  return (await res.json()) as Snapshot;
}

/** Pipes one hook payload through the real shim, as Claude Code does. Resolves when it exits. */
export function runShim(input: string, home: string, url: string): Promise<number | null> {
  return new Promise((done, fail) => {
    const child = spawn("/bin/sh", [SHIM], {
      stdio: ["pipe", "ignore", "ignore"],
      env: {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: home,
        TASKVILLE_HOME: home,
        TASKVILLE_URL: url,
      },
    });
    child.once("error", fail);
    child.once("exit", (code) => done(code));
    child.stdin.on("error", () => {});
    child.stdin.end(input);
  });
}

/** Polls until `test` holds or `timeoutMs` passes; returns the elapsed ms, or undefined on timeout. */
export async function within(
  timeoutMs: number,
  test: () => Promise<boolean>,
  stepMs = 25,
): Promise<number | undefined> {
  const started = performance.now();
  for (;;) {
    if (await test()) return performance.now() - started;
    if (performance.now() - started > timeoutMs) return undefined;
    await new Promise((r) => setTimeout(r, stepMs));
  }
}

/** One line of a recording: the raw hook JSON and when the recorder got it. */
export interface Recorded {
  seq: number;
  offset_ms: number;
  input: Record<string, unknown>;
}

export function readRecording(path: string): Recorded[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Recorded);
}

/** The Taskville agent ID the mapper (M2.03, M2.04) gives a hook's sender. */
export function agentIdOf(hook: Record<string, unknown>): string {
  const session = String(hook.session_id);
  return typeof hook.agent_id === "string" && hook.agent_id !== ""
    ? `claude-code:${session}:${hook.agent_id}`
    : `claude-code:${session}`;
}

export interface LoggedEvent {
  ingestSequence: number;
  type: string;
  late: boolean;
  occurredAt: string;
  agentId?: string;
  sourceId: string;
  payload: Record<string, unknown>;
}

/** The project's event log, read only, straight from `taskville.db` (works while serve runs: WAL). */
export function logEvents(home: string, projectId: string): LoggedEvent[] {
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

/** Tool call IDs (Claude Code `tool_use_id`) with a started or finished event in the log. */
export function loggedToolCalls(home: string, projectId: string): Set<string> {
  const ids = new Set<string>();
  for (const e of logEvents(home, projectId)) {
    if (e.type === "tool_call.started" || e.type === "tool_call.finished") {
      const id = e.payload.toolCallId;
      if (typeof id === "string") ids.add(id);
    }
  }
  return ids;
}
