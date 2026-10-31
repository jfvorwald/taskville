// Claude Code adapter (ARCHITECTURE.md 8.1). The engine's source endpoint (M2.02) calls
// `mapClaudeCodeHook` with each raw hook payload; the crew mapper (M2.04) adds its hooks here.
import type { InputEventWire } from "@taskville/protocol";
import { type HookContext, type MapResult, mapCoreHook } from "./core/index.ts";
import { mapCrewHook } from "./crew/index.ts";

export * from "./core/index.ts";
export {
  attributeHook as attributeCrewHook,
  type CrewMapResult,
  type HookRole,
  mapCrewHook,
} from "./crew/index.ts";

/**
 * Maps one raw Claude Code hook payload to protocol v1 input events. Pure and deterministic:
 * the same payload and context always give the same events and IDs.
 */
export function mapClaudeCodeHook(payload: unknown, ctx: HookContext): MapResult {
  const core = mapCoreHook(payload, ctx);
  // Crew events (subagents and teams) follow core's for the same hook. Crew events are protocol
  // v1 input events built as plain objects; the adapter tests parse every one.
  const crew = mapCrewHook(payload, ctx);
  const events = [...core.events, ...(crew.events as InputEventWire[])];
  if (events.length === 0) {
    return { events, ignored: `core: ${core.ignored ?? "-"}; crew: ${crew.ignored ?? "-"}` };
  }
  return { events, ...(core.evidence === undefined ? {} : { evidence: core.evidence }) };
}
