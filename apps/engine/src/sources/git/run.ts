import { execFile } from "node:child_process";

// Runs git for the watcher (ARCHITECTURE.md 8.2): read-only commands only, through execFile
// with an argument array (never a shell), bounded in time and output.

/** Runs `git <args>` in `cwd` and resolves with its stdout. Rejects on any failure. */
export type GitRunner = (cwd: string, args: readonly string[]) => Promise<string>;

/** A git command that takes longer is killed. */
export const GIT_TIMEOUT_MS = 10_000;
/** Largest stdout accepted from one git command. */
export const GIT_MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Transports that can start a program named by the repository's own configuration. */
const TRANSPORTS = ["ext", "file", "ssh", "http", "https", "git"];

/**
 * Settings forced on every command. `core.fsmonitor` and `log.showSignature` would make git
 * run another program (a monitor hook, gpg) from the repository's own configuration.
 *
 * `protocol.allow=never` plus `protocol.<name>.allow=never` refuse every transport, so no program
 * named by `remote.<r>.uploadpack`, `core.sshCommand`, `credential.helper` or an `ext::` URL can
 * start, even on a git too old to know `GIT_NO_LAZY_FETCH`. The per-transport lines are needed
 * because the repository can set `protocol.<name>.allow=always`, which beats the blanket
 * `protocol.allow`; `-c` on the command line beats the repository. This is the second guard
 * against a partial-clone lazy fetch (see `gitEnv`): either one alone stops it.
 */
const SAFE_CONFIG = [
  "-c",
  "core.fsmonitor=false",
  "-c",
  "log.showSignature=false",
  "-c",
  "protocol.allow=never",
  ...TRANSPORTS.flatMap((name) => ["-c", `protocol.${name}.allow=never`]),
];

/**
 * The engine's environment without any `GIT_*` variable (a stray `GIT_DIR` would point every
 * command at another repository), plus `GIT_OPTIONAL_LOCKS=0` so no command refreshes the
 * index, and no terminal prompts. `GIT_NO_LAZY_FETCH=1` (git 2.44 and later) stops a partial
 * clone from fetching a missing object, which would run the program the repository's own
 * `.git/config` names for its promisor remote.
 */
function gitEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith("GIT_")) env[key] = value;
  }
  env.GIT_OPTIONAL_LOCKS = "0";
  env.GIT_TERMINAL_PROMPT = "0";
  env.GIT_NO_LAZY_FETCH = "1";
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
