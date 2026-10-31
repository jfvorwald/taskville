import type {
  CommandStatus,
  CommandType,
  RequestKind,
  RequestState,
  StoredReason,
} from "@taskville/protocol";

/**
 * A request for the user's attention (permission, elicitation, or input), projected from
 * `request.*` events (data-model.md "Requests and commands").
 */
export interface PendingRequest {
  id: string;
  agentId: string;
  sessionId?: string;
  kind: RequestKind;
  toolName?: string;
  inputPreview?: string;
  reason?: StoredReason;
  /**
   * True when the source guessed which agent the request belongs to (decision #120), for
   * example a split-pane teammate's prompt shown on its lead. Absent otherwise.
   */
  heuristic?: true;
  /** True only for a request held by the permission bridge (`taskville:bridge`). */
  answerable: boolean;
  openedAt: string;
  expiresAt?: string;
  state: RequestState;
  /** Opened by a late (spooled) event: recorded as `expired`, never `needs_you`. */
  late: boolean;
  /**
   * IDs of the requests merged into this record by "one prompt, one red state", in event order.
   * `request.resolved` and `request.expired` for any of them close this record.
   */
  mergedRequestIds: string[];
}

/** A command relayed to a source, projected from `command.*` events. */
export interface Command {
  id: string;
  type: CommandType;
  requestId: string;
  payload: Record<string, unknown>;
  status: CommandStatus;
  idempotencyKey: string;
  updatedAt: string;
  /** The engine's reason, set only by `command.failed`. */
  reason?: StoredReason;
}

/** The state slice owned by the requests sub-reducer. */
export interface RequestsState {
  requests: Record<string, PendingRequest>;
  commands: Record<string, Command>;
}
