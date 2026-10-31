import { execFile } from "node:child_process";

// Runs git for the watcher (ARCHITECTURE.md 8.2): read-only commands only, through execFile
// with an argument array (never a shell), bounded in time and output.

/** Runs `git <args>` in `cwd` and resolves with its stdout. Rejects on any failure. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/** A git command that takes longer is killed. */
export const GIT_TIMEOUT_MS = 10_000;
/** Largest stdout accepted from one git command. */
export const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/**
 * Settings forced on every command. `core.fsmonitor` and `log.showSignature` would make git
 * run another program (a monitor hook, gpg) from the repository's own configuration.
 */
const SAFE_CONFIG = ["-c", "core.fsmonitor=false", "-c", "log.showSignature=false"];

/**
 * The engine's environment without any `GIT_*` variable (a stray `GIT_DIR` would point every
 * command at another repository), plus `GIT_OPTIONAL_LOCKS=0` so no command refreshes the
 * index, and no terminal prompts.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  return env;
}

export const runGit: GitRunner = (cwd, args) =>
  new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-pager", ...SAFE_CONFIG, ...args],
      {
        cwd,
        env: gitEnv(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
