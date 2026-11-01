import { spawn } from "node:child_process";
import { stat } from "node:fs/promises";
import { OpenerValueError, renderOpener } from "../config/opener.ts";

// "Open session" (ARCHITECTURE.md): copy-only unless the owner configured an opener template.
// The template comes only from the engine config (config file or CLI), never from a request, and
// runs through execFile with an argument array, never a shell.

/** What a caller supplies. Anything else on the request, such as a template, is ignored. */
export interface OpenSessionRequest {
  sessionId: string;
  cwd: string;
}

/** The only template source: the loaded engine config. */
export interface OpenSessionConfig {
  sessionOpener: string[] | null;
}

/** `shell` is always false, so no argument is ever interpreted by a shell. */
export type OpenSessionExecOptions = { shell: false; windowsHide: true };

export type OpenSessionExecFile = (
  file: string,
  args: string[],
  options: OpenSessionExecOptions,
) => Promise<unknown>;

export interface OpenSessionDeps {
  config: OpenSessionConfig;
  execFile: OpenSessionExecFile;
  /**
   * Directory check for the request cwd. Optional so callers with a fake `execFile` need no real
   * path, but the production wiring (the M4.03 command service) must pass `defaultIsDirectory`:
   * without it a cwd that is a file (such as an `x.command` script) reaches the opener.
   */
  isDirectory?: (path: string) => Promise<boolean>;
}

export type OpenSessionResult =
  | { status: "copy-only" | "opened"; sessionId: string; cwd: string }
  | {
      status: "failed";
      reason: "invalid-value" | "spawn-failed";
      message: string;
      sessionId: string;
      cwd: string;
    };

const DEFAULT_GRACE_MS = 2000;

/**
 * An `OpenSessionExecFile` with launch semantics: the opener is spawned detached with ignored
 * stdio (nothing is buffered, so a chatty opener is never killed). It resolves once the child
 * survives `graceMs` (the child is left running) or exits 0 inside that window, and rejects with
 * an error whose `code` is the non-zero exit code or the spawn error code (such as ENOENT).
 */
export function createDefaultExecFile({
  graceMs = DEFAULT_GRACE_MS,
}: {
  graceMs?: number;
} = {}): OpenSessionExecFile {
  return (file, args, options) =>
    new Promise<void>((resolve, reject) => {
      const child = spawn(file, args, {
        ...options,
        stdio: "ignore",
        detached: true,
      });
      let settled = false;
      const settle = (error?: Error): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.off("exit", onExit);
        if (error) reject(error);
        else resolve();
      };
      const onExit = (code: number | null, signal: NodeJS.Signals | null): void => {
        if (code === 0) {
          settle();
          return;
        }
        const exitCode = code ?? signal ?? "unknown";
        settle(Object.assign(new Error(`The opener exited with ${exitCode}`), { code: exitCode }));
      };
      const timer = setTimeout(() => {
        child.unref();
        settle();
      }, graceMs);
      // Stays attached after settling, so a late error cannot crash the engine.
      child.on("error", (error) => settle(error));
      child.on("exit", onExit);
    });
}

/** The real `execFile` for `OpenSessionDeps`. */
export const defaultExecFile: OpenSessionExecFile = createDefaultExecFile();

/** The real directory check for `OpenSessionDeps.isDirectory`: false for files and missing paths. */
export async function defaultIsDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function openSession(
  request: OpenSessionRequest,
  deps: OpenSessionDeps,
): Promise<OpenSessionResult> {
  const { sessionId, cwd } = request;
  const template = deps.config.sessionOpener;
  if (template === null) return { status: "copy-only", sessionId, cwd };

  if (deps.isDirectory && !(await deps.isDirectory(cwd))) {
    return {
      status: "failed",
      reason: "invalid-value",
      message: "The session directory does not exist or is not a directory",
      sessionId,
      cwd,
    };
  }

  let command: { file: string; args: string[] };
  try {
    command = renderOpener(template, { sessionId, cwd });
  } catch (error) {
    if (!(error instanceof OpenerValueError)) throw error;
    return { status: "failed", reason: "invalid-value", message: error.message, sessionId, cwd };
  }

  try {
    await deps.execFile(command.file, command.args, { shell: false, windowsHide: true });
  } catch (error) {
    // Only the error code is reported: the raw message can carry the arguments and the path.
    const code = (error as { code?: unknown } | null)?.code;
    const detail = typeof code === "string" || typeof code === "number" ? ` (${code})` : "";
    return {
      status: "failed",
      reason: "spawn-failed",
      message: `The session opener could not be started${detail}`,
      sessionId,
      cwd,
    };
  }
  return { status: "opened", sessionId, cwd };
}
