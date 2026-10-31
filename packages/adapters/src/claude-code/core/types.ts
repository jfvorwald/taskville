import type { InputEventWire } from "@taskville/protocol";

/** What the engine knows about one raw hook payload (ARCHITECTURE.md 8.1). */
export interface HookContext {
  /** Engine-assigned from the working directory. */
  projectId: string;
  /** The shim's ID for this payload. Derived event and request IDs are built from it. */
  sourceEventId: string;
  /** Engine receive time; hook payloads carry no timestamp, so it is every event's occurredAt. */
  receivedAt: string;
  /** True for payloads replayed from the telemetry spool. */
  late: boolean;
}

/** Raw tool input or output for the evidence store (M2.06), which redacts it. */
export interface ToolEvidence {
  toolCallId: string;
  input?: unknown;
  output?: unknown;
}

export interface MapResult {
  /** Protocol v1 input events, in the order they should be ingested. */
  events: InputEventWire[];
  evidence?: ToolEvidence[];
  /** Why the payload produced no events, for diagnostics. Never contains payload text. */
  ignored?: string;
}

/** The Taskville agent and session a hook belongs to. */
export interface HookSubject {
  /** Envelope `agentId`. */
  agentId: string;
  /** Envelope `sessionId`: the Claude Code `session_id`, the parent's for subagent hooks. */
  sessionId: string;
  /** The hook's `agent_id`, present when the hook fired inside a subagent or teammate. */
  sourceAgentId?: string;
}
