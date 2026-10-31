// Claude Code telemetry source (ARCHITECTURE.md 8.1): the hooks route, project
// resolution from `cwd`, and the entry point the spool replay (M2.07) calls.
/** The real mapper (M2.03), re-exported so `taskville serve` composes the source from here. */
export { mapClaudeCodeHook } from "@taskville/adapters/claude-code";
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
