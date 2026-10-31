// Test harness for the telemetry shim: spawns the real script under a POSIX
// shell and runs a tiny HTTP server that stands in for the engine.

import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { createServer, type IncomingHttpHeaders, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const SHIM = join(import.meta.dirname, "..", "..", "hooks", "claude-code-shim.sh");

/** `/bin/sh` always; `dash` too where installed (Linux default sh, and present on macOS). */
export const SHELLS = ["/bin/sh", "/bin/dash"].filter((shell) => existsSync(shell));

/** A 43-character base64url token, the shape `generateSecret` produces. */
export const TOKEN = "tvTestToken_0123456789-abcdefghijklmnopqrstu";

export interface Home {
  root: string;
  home: string;
  spoolDir: string;
  spoolFile: string;
  remove(): void;
}

/** A temporary root with a Taskville home holding a CLI token (as `serve` leaves it). */
export function makeHome(options: { token?: boolean } = {}): Home {
  const root = mkdtempSync(join(tmpdir(), "taskville-shim-"));
  const home = join(root, "home");
  const spoolDir = join(home, "spool");
  mkdirSync(spoolDir, { recursive: true, mode: 0o700 });
  if (options.token !== false) {
    const write = spawnSync("sh", [
      "-c",
      `umask 077; printf '%s\\n' "$1" > "$2"`,
      "sh",
      TOKEN,
      join(home, "token"),
    ]);
    if (write.status !== 0) throw new Error("could not write token");
  }
  return {
    root,
    home,
    spoolDir,
    spoolFile: join(spoolDir, "claude-code.jsonl"),
    remove: () => rmSync(root, { recursive: true, force: true }),
  };
}

export interface ShimRun {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface ShimOptions {
  shell: string;
  input: string | Buffer;
  env: Record<string, string>;
  /** Called with the child's PID once it is running. */
  onSpawn?: (pid: number) => void;
}

/** Runs the shim once, piping `input` to its stdin. */
export function runShim(options: ShimOptions): Promise<ShimRun> {
  const started = performance.now();
  return new Promise((resolve, reject) => {
    const child = spawn(options.shell, [SHIM], {
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code, stdout, stderr, ms: performance.now() - started });
    });
    if (child.pid !== undefined) options.onSpawn?.(child.pid);
    // The shim may stop reading early (oversized input); that is not an error.
    child.stdin.on("error", () => {});
    child.stdin.end(options.input);
  });
}

/** The environment a hook runs with: nothing from the developer's own shell. */
export function shimEnv(home: Home, url: string, extra: Record<string, string> = {}) {
  return {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: home.root,
    TASKVILLE_HOME: home.home,
    TASKVILLE_URL: url,
    ...extra,
  };
}

export interface Received {
  method: string;
  url: string;
  headers: IncomingHttpHeaders;
  body: string;
}

export type Mode = { kind: "status"; status: number } | { kind: "hang" };

/** A stand-in engine on 127.0.0.1 that records every request. */
export async function startServer(initial: Mode = { kind: "status", status: 202 }) {
  const received: Received[] = [];
  const hanging = new Set<() => void>();
  let mode = initial;
  const server: Server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => {
      received.push({
        method: req.method ?? "",
        url: req.url ?? "",
        headers: req.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      });
      if (mode.kind === "hang") {
        hanging.add(() => res.destroy());
        return;
      }
      res.writeHead(mode.status, { "content-type": "application/json" });
      res.end("{}");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    port,
    url: `http://127.0.0.1:${port}`,
    received,
    setMode(next: Mode) {
      mode = next;
    },
    async close() {
      for (const end of hanging) end();
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}

/** A port nothing listens on (bound and released a moment ago). */
export async function deadUrl(): Promise<string> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return `http://127.0.0.1:${port}`;
}

export interface SpoolLine {
  payload: unknown;
  sourceEventId: string;
  spooledAt: string;
  payloadBytesAtLeast?: number;
}

/** Every spool file (`claude-code.jsonl` and `claude-code.*.jsonl`), raw text by name. */
export function spoolFiles(home: Home): Map<string, string> {
  const files = new Map<string, string>();
  if (!existsSync(home.spoolDir)) return files;
  for (const name of readdirSync(home.spoolDir).sort()) {
    if (/^claude-code(\.[^.]+)?\.jsonl$/.test(name)) {
      files.set(name, readFileSync(join(home.spoolDir, name), "utf8"));
    }
  }
  return files;
}

/** Parses every spool line across all spool files; throws on any malformed line. */
export function spoolLines(home: Home): SpoolLine[] {
  const lines: SpoolLine[] = [];
  for (const [name, text] of spoolFiles(home)) {
    if (!text.endsWith("\n")) throw new Error(`${name} does not end with a newline`);
    for (const line of text.slice(0, -1).split("\n")) {
      lines.push(JSON.parse(line) as SpoolLine);
    }
  }
  return lines;
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const UTC_SECONDS = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/;

/** A hook payload in Claude Code's shape, padded to roughly `bytes`. */
export function hookPayload(index: number, bytes = 200): Record<string, unknown> {
  const base = {
    session_id: `session-${index}`,
    transcript_path: "/redacted/transcript.jsonl",
    cwd: "/redacted/project",
    hook_event_name: "PostToolUse",
    tool_name: "Bash",
    tool_input: { command: `echo ${index}` },
    tool_response: { stdout: "" },
    tool_use_id: `toolu_${index}`,
  };
  const pad = Math.max(0, bytes - JSON.stringify(base).length);
  // Quotes, backslashes, and non-ASCII so escaping mistakes would show.
  const filler = `${"x".repeat(pad)}`.replace(/x{40}/g, 'x"\\ é 🙂 x'.padEnd(40, "x"));
  return { ...base, tool_response: { stdout: filler } };
}
