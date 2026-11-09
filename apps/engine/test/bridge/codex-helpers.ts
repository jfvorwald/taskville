import { input } from "../stream/helpers.ts";
import { BRIDGE_TOKEN, bearer, CWD } from "./helpers.ts";

export { ALLOW_BODY, denyBody } from "./helpers.ts";

/**
 * A1.02 (#507): the Codex permission bridge. Names pinned by these tests:
 * - `CODEX_BRIDGE_PERMISSION_PATH` and `DEFAULT_CODEX_HOLD_WINDOW_MS` (5000), exported from
 *   `src/bridge/index.ts`;
 * - `PermissionBridgeOptions.codexHoldWindowMs`, so the Codex hold is set apart from the Claude
 *   Code hold (`holdWindowMs`, 90 s);
 * - `PermissionBridge.handleCodex(raw, signal)`, the Codex twin of `handle`;
 * - `PermissionBridge.observeCodexHook(raw)`, which the Codex telemetry route calls with every
 *   accepted hook (PreToolUse, PostToolUse, Interrupt are the ones it uses);
 * - `registerBridgeRoutes(app, bridge)` registers the Codex route next to the Claude Code one.
 */
export const CODEX_BRIDGE_PERMISSION_PATH = "/v1/bridge/codex/permission";
export const CODEX_HOLD_MS = 5_000;
export const CODEX_SESSION = "01a1bd20-2aeb-78d2-8cd2-11d3026574a7";
export const CODEX_AGENT = `codex:${CODEX_SESSION}`;
export const TURN = "01a1bd20-6ac8-70e3-8c1d-0e04db1eed8b";
export const OTHER_TURN = "01a1bd20-6ac8-70e3-8c1d-0e04db1eed00";
export const CHILD = "01a1bd22-1ffe-77b0-a9f5-0de8a97c2ae1";
export const COMMAND = "curl -s -X POST http://127.0.0.1:47805/ping";
const BASE = "http://127.0.0.1:4807";

const common = (event: string) => ({
  session_id: CODEX_SESSION,
  turn_id: TURN,
  transcript_path: `~/.codex/sessions/rollout-${CODEX_SESSION}.jsonl`,
  cwd: CWD,
  hook_event_name: event,
  model: "gpt-6-luna",
  permission_mode: "default",
});

/** The raw Codex PermissionRequest hook (fixtures/codex/tui-hooks.jsonl): no tool_use_id. */
export function codexPermissionHook(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...common("PermissionRequest"),
    tool_name: "Bash",
    tool_input: {
      command: COMMAND,
      description: "May I run the requested POST request outside the network sandbox?",
    },
    ...overrides,
  };
}

export function codexPreToolUse(
  toolUseId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...common("PreToolUse"),
    tool_name: "Bash",
    tool_input: { command: COMMAND },
    tool_use_id: toolUseId,
    ...overrides,
  };
}

/** A PostToolUse carries `tool_input` without the permission request's `description`. */
export function codexPostToolUse(
  toolUseId: string,
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    ...common("PostToolUse"),
    tool_name: "Bash",
    tool_input: { command: COMMAND },
    tool_response: "{}",
    tool_use_id: toolUseId,
    ...overrides,
  };
}

export const codexInterrupt = (overrides: Record<string, unknown> = {}) => ({
  ...common("Interrupt"),
  ...overrides,
});

export function postCodexPermission(
  app: { request: (input: string, init?: RequestInit) => Response | Promise<Response> },
  body: unknown,
  headers: Record<string, string> = bearer(BRIDGE_TOKEN),
): Promise<Response> {
  return Promise.resolve(
    app.request(`${BASE}${CODEX_BRIDGE_PERMISSION_PATH}`, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify(body),
    }),
  );
}

/** Registers the Codex session agent, as the telemetry route would have on SessionStart. */
export function registerCodexAgent(engine: {
  pipeline: { ingest: (events: unknown[]) => unknown };
}): void {
  engine.pipeline.ingest([
    input("codex-agent-1", {
      type: "agent.registered",
      agentId: CODEX_AGENT,
      sessionId: CODEX_SESSION,
      sourceId: "codex",
      payload: { sourceAgentId: CODEX_SESSION, displayName: "proj", role: "main", kind: "session" },
    }),
  ]);
}

/** Schedules with real timers, for the tiny-hold test that waits for the expiry itself. */
export const realSchedule = (run: () => void, delayMs: number): (() => void) => {
  const timer = setTimeout(run, delayMs);
  return () => clearTimeout(timer);
};
