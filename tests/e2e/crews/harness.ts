// Shared pieces of the M5.11 crews end-to-end run: a real `taskville serve --headless` (reusing the
// M4.10 permission harness), and a replay of recorded Claude Code hook payloads through the same
// telemetry route the shim posts to. No model and no live `claude` (decision #289 default).

import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type PermissionEngine, REPO, TELEMETRY_PATH } from "../permission/harness.ts";

export type { PermissionEngine as Engine } from "../permission/harness.ts";
export { PROJECT_ID, startPermissionEngine as startEngine } from "../permission/harness.ts";

export const SUBAGENT_FIXTURE = join(REPO, "fixtures/claude-code/subagent/parallel.jsonl");
export const TEAM_FIXTURE = join(REPO, "fixtures/claude-code/team/in-process.jsonl");

/** One line of a recording: the raw hook JSON exactly as Claude Code sent it. */
export interface Recorded {
  seq: number;
  offset_ms: number;
  input: Record<string, unknown>;
}

export function readRecording(path: string): Recorded[] {
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Recorded);
}

/** POSTs one recorded hook payload, untouched, to the engine's telemetry route. */
export async function postHook(engine: PermissionEngine, hook: Recorded): Promise<void> {
  const res = await fetch(`${engine.url}${TELEMETRY_PATH}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${engine.cliToken}` },
    body: JSON.stringify({ payload: hook.input, sourceEventId: randomUUID() }),
  });
  if (res.status >= 300) {
    throw new Error(`hook ${hook.seq} (${hook.input.hook_event_name}) refused: ${res.status}`);
  }
}

export const hookName = (r: Recorded): string => String(r.input.hook_event_name);

export interface SnapshotAgent {
  id: string;
  kind: string;
  displayName?: string;
  parentAgentId?: string;
  teamId?: string;
}

export interface SnapshotState {
  agents: Record<string, SnapshotAgent>;
  teams: Record<string, { id: string; leadAgentId: string; memberAgentIds: string[] }>;
  toolCalls: Record<string, { id: string; agentId: string; toolName?: string; phase: string }>;
}

export async function snapshotOf(
  engine: PermissionEngine,
  projectId: string,
): Promise<SnapshotState> {
  const res = await fetch(`${engine.url}/v1/projects/${projectId}/snapshot`, {
    headers: { Authorization: `Bearer ${engine.cliToken}` },
  });
  if (res.status !== 200) throw new Error(`snapshot ${res.status}: ${await res.text()}`);
  return ((await res.json()) as { state: SnapshotState }).state;
}
