// Codex telemetry source (A1.02, docs/spikes/S-5-codex.md): the hooks route and the spool replay,
// both on the Claude Code source's machinery with the Codex mapper and the `codex` spool files.
import { lstatSync, readdirSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Hono } from "hono";
import type { AppEnv } from "../../http/app.ts";
import {
  type ClaudeCodeRouteOptions,
  type DrainOptions,
  drainSpool,
  registerHooksRoute,
  replaySpool,
  type SpoolReplayOptions,
  type SpoolReplayReport,
  STALE_MS,
} from "../claude-code/index.ts";
import type { CodexSource } from "./source.ts";

export {
  CODEX_SOURCE_ID,
  CodexSource,
  type CodexSourceOptions,
  MAX_OPEN_TOOL_CALLS,
} from "./source.ts";

export const CODEX_HOOKS_PATH = "/v1/sources/codex/hooks";

/**
 * `POST /v1/sources/codex/hooks`: the Codex shim posts one raw hook as `{ sourceEventId, payload }`
 * with the CLI token. Same body, credential (`ingest` scope), and size rules as the Claude Code
 * route; `observeHook` gets the raw payload of each accepted hook (the permission bridge's
 * `observeCodexHook`).
 */
export function registerCodexRoutes(
  app: Hono<AppEnv>,
  source: CodexSource,
  options: ClaudeCodeRouteOptions = {},
): void {
  registerHooksRoute(app, CODEX_HOOKS_PATH, source, options);
}

/** The forwarder's working directories in the Taskville home (`codex-permission-bridge.sh`). */
const FORWARDER_TEMP = /^\.codex-permission\.[A-Za-z0-9]+$/;

/**
 * Removes the forwarder temp directories a killed hook left in the Taskville home (the spool
 * folder's parent) once they are older than the spool's stale age. A symlink with that name is
 * removed itself, never followed. Never throws: a sweep that fails is tried again next start.
 */
function sweepForwarderTemps(spoolDir: string, nowMs: number): void {
  const home = dirname(spoolDir);
  try {
    for (const name of readdirSync(home)) {
      if (!FORWARDER_TEMP.test(name)) continue;
      const path = join(home, name);
      try {
        if (nowMs - lstatSync(path).mtimeMs <= STALE_MS) continue;
        rmSync(path, { recursive: true, force: true });
      } catch {
        // Gone already, or not removable now.
      }
    }
  } catch {
    // No readable home.
  }
}

/**
 * Replays `codex.jsonl` and the Codex per-event spool files (`late: true`), as the Claude Code
 * replay does, and sweeps stale forwarder temp directories.
 */
export function replayCodexSpool(
  options: Omit<SpoolReplayOptions, "prefix"> & { source: CodexSource },
): Promise<SpoolReplayReport> {
  sweepForwarderTemps(options.spoolDir, (options.now ?? Date.now)());
  return replaySpool({ ...options, prefix: "codex" });
}

/** `drainSpool` for the Codex files: bounded runs until nothing is left. */
export function drainCodexSpool(
  options: Omit<DrainOptions, "prefix"> & { source: CodexSource },
): Promise<SpoolReplayReport> {
  return drainSpool({ ...options, prefix: "codex" });
}
