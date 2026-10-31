import type {
  Activity,
  AgentKind,
  Connection,
  LastTurn,
  Provenance,
  StoredEnvelope,
  TaskStatus,
  ToolCallPhase,
} from "@taskville/protocol";
import type { IdMap } from "./maps.ts";

// Entity state (data-model.md "Domain state"). Every value is JSON: no Map, no Date, no
// undefined-valued properties, so canonicalJson hashes it and the engine stores it as is.
// Timestamps are the source's `occurredAt` text; the reducer never reads a clock.

/** The events the reducer applies: stored envelopes, after masking and truncation. */
export type DomainEvent = StoredEnvelope;

export interface Agent {
  readonly id: string;
  /** Source of the first registration; for an unregistered agent, of the first event seen. */
  readonly sourceId: string;
  /** With `sourceId`, the agent's identity. Absent until `agent.registered`. Never changes. */
  readonly sourceAgentId?: string;
  readonly displayName?: string;
  readonly role?: string;
  /** `unknown` until registered, or when the source sent a kind Taskville does not know. */
  readonly kind: AgentKind;
  /** The source's own kind value, kept when `kind` is `unknown`. */
  readonly sourceValue?: string;
  /** Only for `subagent` (or `unknown`): set by a registration, never guessed. */
  readonly parentAgentId?: string;
  /** Only for `lead` and `teammate` (or `unknown`). */
  readonly teamId?: string;
  readonly registered: boolean;
  /** Ingest sequence of the first registration; orders team members. */
  readonly registeredSeq?: number;
  readonly connection: Connection;
  /** Earliest and latest `occurredAt` of any event naming this agent, by instant. */
  readonly firstSeenAt: string;
  readonly lastSeenAt: string;
  readonly finishedAt?: string;
  readonly toolCallCount: number;
  readonly consecutiveToolFailures: number;
  /** The agent's latest turn event, until a prompt or tool call clears it. */
  readonly lastTurn?: LastTurn;
  readonly lastTurnAt?: string;
}

export interface Team {
  readonly id: string;
  readonly leadAgentId: string;
  readonly name?: string;
  /** Agents whose `teamId` is this team, ordered by first registration. */
  readonly memberAgentIds: readonly string[];
  readonly startedAt: string;
  readonly endedAt?: string;
}

export interface ActivityEntry {
  readonly activity: Activity;
  readonly sourceValue?: string;
  readonly heuristic: boolean;
  readonly since: string;
  readonly taskId?: string;
}

export interface Session {
  readonly id: string;
  /** The agent that first reported this session. Other agents never change it. */
  readonly agentId: string;
  readonly sourceId: string;
  readonly provenance: Provenance;
  readonly firstSeenAt: string;
  /** Set by `session.started`; absent for a session first heard of from another event. */
  readonly startedAt?: string;
  /** Ingest sequence at which the session was opened; the latest open one is primary. */
  readonly startSeq: number;
  readonly endedAt?: string;
  readonly workingDirectory?: string;
  readonly activity: ActivityEntry;
}

export interface ToolCall {
  readonly id: string;
  readonly agentId: string;
  readonly sessionId?: string;
  /** Absent only for a finish whose start was never seen. */
  readonly toolName?: string;
  readonly phase: ToolCallPhase;
  readonly filePaths: readonly string[];
  readonly summary?: string;
  readonly evidenceIds: readonly string[];
  /** Absent only for a finish whose start was never seen. */
  readonly startedAt?: string;
  readonly finishedAt?: string;
  readonly durationMs?: number;
  /** Ingest sequence at which the call was first seen; orders eviction. */
  readonly startSeq: number;
}

export interface TransitionWarning {
  readonly from: TaskStatus;
  readonly to: TaskStatus;
  readonly at: string;
}

export interface Task {
  readonly id: string;
  /** Absent until `task.created` arrives, if another task event came first. */
  readonly title?: string;
  readonly status: TaskStatus;
  /** The source's own status value, kept when `status` is `unknown`. */
  readonly sourceValue?: string;
  /** Ordered by assignment time. */
  readonly assignedAgentIds: readonly string[];
  readonly relatedTaskIds: readonly string[];
  readonly createdAt?: string;
  readonly updatedAt: string;
  /** The latest transition outside the state graph, if any. Applied, but flagged. */
  readonly transitionWarning?: TransitionWarning;
}

export interface TestResultEvidence {
  readonly kind: "test_result";
  readonly eventId: string;
  readonly at: string;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

/**
 * An agent's primary activity: that of its most recently started open session, or, when it has
 * no open session, of the agent itself (`sessionId` absent).
 */
export interface AgentActivity extends ActivityEntry {
  readonly agentId: string;
  readonly sessionId?: string;
  readonly latestEvidence?: TestResultEvidence;
  readonly openSessionCount: number;
}

export interface EntitiesState {
  readonly agents: IdMap<Agent>;
  readonly teams: IdMap<Team>;
  readonly sessions: IdMap<Session>;
  /** Bounded (SC-006): open calls, at most MAX_OPEN_TOOL_CALLS_PER_AGENT per agent, plus each
   * agent's latest finished call. Older calls stay in the event log. */
  readonly toolCalls: IdMap<ToolCall>;
  readonly tasks: IdMap<Task>;
  readonly activity: IdMap<AgentActivity>;
}
