// Codex telemetry source (A1.02, docs/spikes/S-5-codex.md): the hooks route and the spool replay,
// both on the Claude Code source's machinery with the Codex mapper and the `codex` spool files.
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

/** Replays `codex.jsonl` and the Codex per-event spool files (`late: true`), as the Claude Code replay does. */
export function replayCodexSpool(
  options: Omit<SpoolReplayOptions, "prefix"> & { source: CodexSource },
): Promise<SpoolReplayReport> {
  return replaySpool({ ...options, prefix: "codex" });
}

/** `drainSpool` for the Codex files: bounded runs until nothing is left. */
export function drainCodexSpool(
  options: Omit<DrainOptions, "prefix"> & { source: CodexSource },
): Promise<SpoolReplayReport> {
  return drainSpool({ ...options, prefix: "codex" });
}
