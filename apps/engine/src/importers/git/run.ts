import { execFile } from "node:child_process";
import { GIT_MAX_OUTPUT_BYTES, GIT_TIMEOUT_MS } from "../../sources/git/index.ts";

// Runs git for the importer (imports design, "Importers: Git"): read-only commands only, through
// execFile with an argument array (never a shell), bounded in time and output like the live
// watcher's runner, and with an environment that ignores the user's and the system's git config.

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
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      "git",
      ["--no-pager", ...SAFE_CONFIG, ...args],
      {
        cwd,
        env: importGitEnv(),
        timeout: GIT_TIMEOUT_MS,
        maxBuffer: GIT_MAX_OUTPUT_BYTES,
        encoding: "utf8",
        windowsHide: true,
        signal,
      },
      (error, stdout) => (error ? reject(error) : resolve(stdout)),
    );
  });
}
