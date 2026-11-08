import { execFile } from "node:child_process";
import { GIT_MAX_OUTPUT_BYTES } from "../../sources/git/index.ts";

// Runs git for the importer (imports design, "Importers: Git"): read-only commands only, through
// execFile with an argument array (never a shell), bounded in time and output like the live
// watcher's runner, and with an environment that ignores the user's and the system's git config.

/** Imports walk whole histories, so each git call may run longer than the watcher's 10 s. */
export const IMPORT_GIT_TIMEOUT_MS = 60_000;
export const IMPORT_GIT_MAX_OUTPUT_BYTES = GIT_MAX_OUTPUT_BYTES;

export interface GitLimits {
  timeoutMs: number;
  maxOutputBytes: number;
}

/** A git failure with a fixed message (no path, stderr or argv); `exitCode` is git's, if any. */
export class GitFailure extends Error {
  readonly exitCode: number | undefined;

  constructor(
    message: "not_a_repository" | "git_timeout" | "git_output_too_large" | "git_failed",
    exitCode?: number,
  ) {
    super(message);
    this.name = "GitFailure";
    this.exitCode = exitCode;
  }
}

/** Same forced settings as the live watcher's runner (`sources/git/run.ts`). */
const SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "protocol.allow=never",
];

function importGitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_") && !key.startsWith("LC_")) env[key] = value;
  }
  env.GIT_CONFIG_GLOBAL = "/dev/null";
  env.GIT_CONFIG_NOSYSTEM = "1";
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_LAZY_FETCH = "1";
  env.GIT_ALLOW_PROTOCOL = "";
  env.LC_ALL = "C";
  return env;
}

/** Runs `git <args>` in `cwd` and resolves with its stdout. Rejects on failure or abort. */
export function runImportGit(
  cwd: string,
  args: readonly string[],
  signal: AbortSignal,
  limits: GitLimits,
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-pager", "--no-replace-objects", ...SAFE_CONFIG, ...args],
      {
        cwd,
        env: importGitEnv(),
        timeout: limits.timeoutMs,
        maxBuffer: limits.maxOutputBytes,
        encoding: "utf8",
        windowsHide: true,
        signal,
      },
      (error, stdout, stderr) => {
        if (!error) return resolve(stdout);
        reject(toFailure(error, stderr));
      },
    );
  });
}

function toFailure(
  error: Error & { code?: number | string; killed?: boolean },
  stderr: string,
): Error {
  if (error.name === "AbortError") return error;
  if (error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
    return new GitFailure("git_output_too_large");
  }
  if (error.killed === true) return new GitFailure("git_timeout");
  const exitCode = typeof error.code === "number" ? error.code : undefined;
  if (/not a git repository/i.test(stderr)) return new GitFailure("not_a_repository", exitCode);
  return new GitFailure("git_failed", exitCode);
}
