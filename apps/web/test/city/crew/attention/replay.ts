import { readFileSync } from "node:fs";
import { join } from "node:path";
import { mapClaudeCodeHook } from "../../../../../../packages/adapters/src/claude-code/index.ts";
import {
  parseInputEvent,
  storedEnvelopeSchemas,
} from "../../../../../../packages/protocol/src/index.ts";
import {
  type Agent,
  attention,
  initialState,
  type ProjectState,
  reduce,
  type StoredEnvelope,
} from "../../../../src/data/domain.ts";

// Replays an S-2 hook stream (fixtures/claude-code/{subagent,team}, already redacted) through the
// real Claude Code adapter and the real reducer, as the engine will. Nothing is copied from the
// fixtures: they are read from disk.

const FIXTURES = join(
  import.meta.dirname,
  "..",
  "..",
  "..",
  "..",
  "..",
  "..",
  "fixtures",
  "claude-code",
);
const BASE_MS = Date.UTC(2026, 9, 30, 12, 0, 0);

export const BRIDGE = "taskville:bridge";

export interface Hook {
  seq: number;
  offsetMs: number;
  input: Record<string, unknown>;
}

export function readFixture(name: string): Hook[] {
  return readFileSync(join(FIXTURES, `${name}.jsonl`), "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => {
      const row = JSON.parse(l) as {
        seq: number;
        offset_ms: number;
        input: Record<string, unknown>;
      };
      return { seq: row.seq, offsetMs: row.offset_ms, input: row.input };
    });
}

/** What the engine stores: parsed, reason in its stored form, engine fields added. */
function store(raw: unknown, sequence: number): StoredEnvelope {
  const parsed = parseInputEvent(raw);
  if (!parsed.ok) throw new Error(JSON.stringify(parsed.error));
  const event = parsed.event as StoredEnvelope & { payload: Record<string, unknown> };
  const payload =
    typeof event.payload.reason === "string"
      ? {
          ...event.payload,
          reason: { text: event.payload.reason, masked: false, truncated: false },
        }
      : event.payload;
  return storedEnvelopeSchemas[event.type].parse({
    ...event,
    payload,
    eventId: `00000000-0000-4000-8000-${sequence.toString(16).padStart(12, "0")}`,
    receivedAt: event.occurredAt,
    ingestSequence: sequence,
  }) as StoredEnvelope;
}

export interface Replay {
  state: ProjectState;
  /** Epoch ms of the last hook replayed, plus one second. */
  now: number;
}

/**
 * Plays the stream through hook `upTo` (inclusive; default all). `afterHook` may return a
 * permission request the bridge would open at that point (M4.01 turns a PermissionRequest hook
 * into `request.opened` from `taskville:bridge`; the adapter ignores that hook, so the test
 * stands in for the bridge, using the hook's own `session_id` and the already-mapped agent).
 */
export function replay(
  name: string,
  options: {
    upTo?: number;
    /** Hooks appended after the fixture's own (after `upTo`), for shapes the recordings lack. */
    extra?: Hook[];
    bridge?: (hook: Hook, state: ProjectState) => { agent: Agent; tool: string } | undefined;
  } = {},
): Replay {
  let state = initialState("proj-attention");
  let sequence = 0;
  let now = BASE_MS;
  const hooks = readFixture(name).filter(
    (h) => options.upTo === undefined || h.seq <= options.upTo,
  );
  for (const hook of [...hooks, ...(options.extra ?? [])]) {
    const at = new Date(BASE_MS + Math.round(hook.offsetMs)).toISOString();
    const mapped = mapClaudeCodeHook(hook.input, {
      projectId: "proj-attention",
      sourceEventId: `h-${hook.seq}`,
      receivedAt: at,
      late: false,
    });
    for (const raw of mapped.events) state = reduce(state, store(raw, ++sequence));
    const open = options.bridge?.(hook, state);
    if (open !== undefined) {
      state = reduce(
        state,
        store(
          {
            schemaVersion: 1,
            projectId: "proj-attention",
            sourceId: BRIDGE,
            sourceEventId: `bridge-${hook.seq}`,
            occurredAt: at,
            type: "request.opened",
            agentId: open.agent.id,
            sessionId: String(hook.input.session_id),
            payload: { requestId: `bridge-${hook.seq}`, kind: "permission", toolName: open.tool },
            evidenceIds: [],
            provenance: "live",
            late: false,
          },
          ++sequence,
        ),
      );
    }
    now = BASE_MS + Math.round(hook.offsetMs) + 1000;
  }
  return { state, now };
}

/** The attention records at the replay's own clock. */
export const recordsOf = (r: Replay) => attention(r.state, r.now);

/** The agent registered for `sourceAgentId` (a hook's `agent_id`, or a session id). */
export function agentBySource(state: ProjectState, sourceAgentId: string): Agent {
  const found = Object.values(state.agents).find((a) => a.sourceAgentId === sourceAgentId);
  if (found === undefined) throw new Error(`no agent for ${sourceAgentId}`);
  return found;
}

/** The first agent of `kind` named `displayName`. */
export function agentNamed(state: ProjectState, kind: Agent["kind"], displayName: string): Agent {
  const found = Object.values(state.agents).find(
    (a) => a.kind === kind && a.displayName === displayName,
  );
  if (found === undefined) throw new Error(`no ${kind} named ${displayName}`);
  return found;
}
