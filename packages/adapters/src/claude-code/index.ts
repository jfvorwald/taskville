// Claude Code adapter (ARCHITECTURE.md 8.1). The engine's source endpoint (M2.02) calls
// `mapClaudeCodeHook` with each raw hook payload; the crew mapper (M2.04) adds its hooks here.
import { type HookContext, type MapResult, mapCoreHook } from "./core/index.ts";

export * from "./core/index.ts";

/**
 * Maps one raw Claude Code hook payload to protocol v1 input events. Pure and deterministic:
 * the same payload and context always give the same events and IDs.
 */
export function mapClaudeCodeHook(payload: unknown, ctx: HookContext): MapResult {
  return mapCoreHook(payload, ctx);
}
