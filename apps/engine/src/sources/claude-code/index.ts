// Claude Code telemetry source (ARCHITECTURE.md 8.1): the hooks route, project
// resolution from `cwd`, and the entry point the spool replay (M2.07) calls.
export {
  MAX_CWD_LENGTH,
  matchProjectRoot,
  type ResolveOptions,
  type RoutableProject,
  resolveProjectId,
} from "./resolve-project.ts";
export {
  CLAUDE_CODE_HOOKS_PATH,
  MAX_HOOK_BODY_BYTES,
  MAX_HOOK_SOURCE_EVENT_ID,
  registerClaudeCodeRoutes,
} from "./route.ts";
export {
  CLAUDE_CODE_SOURCE_ID,
  type ClaudeCodeMapper,
  ClaudeCodeSource,
  type ClaudeCodeSourceOptions,
  type EvidenceSink,
  type HookEvidence,
  type HookIngestResponse,
  type HookInput,
  type MapContext,
  type MapResult,
  noopEvidenceSink,
} from "./source.ts";
export {
  DEFAULT_DRAIN_PAUSE_MS,
  DEFAULT_LOCK_WAIT_MS,
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_HOOKS,
  type DrainOptions,
  drainSpool,
  MAX_SPOOL_LINE_BYTES,
  replaySpool,
  SPOOL_FILE,
  type SpoolReplayOptions,
  type SpoolReplayReport,
  STALE_MS,
} from "./spool.ts";
