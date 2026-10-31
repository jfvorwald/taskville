# Data Model: Headless Foundation

Derived from [spec.md](spec.md) Key Entities and ARCHITECTURE.md sections 2.2, 6,
and 7. Two layers: the **domain state** produced by the pure reducer, and the
**storage schema** that persists events and projections. Event names and payloads
are in [contracts/events.md](contracts/events.md).

## Domain state (packages/domain)

```text
ProjectState
  projectId, reducerVersion, head (last ingestSequence applied)
  agents:    Map<AgentId, Agent>
  teams:     Map<TeamId, Team>
  sessions:  Map<SessionId, Session>
  toolCalls: Map<ToolCallId, ToolCall>        (bounded, see below)
  tasks:     Map<TaskId, Task>
  activity:  Map<AgentId, AgentActivity>
  requests:  Map<RequestId, PendingRequest>
  commands:  Map<CommandId, Command>
```

| Entity | Fields | Rules |
| --- | --- | --- |
| Agent | `id`, `sourceId`, `sourceAgentId`, `displayName`, `role`, `kind`, `parentAgentId?`, `teamId?`, `connection`, `lastSeenAt`, `finishedAt?`, `toolCallCount`, `consecutiveToolFailures`, `lastTurn?` | Identity key is `(sourceId, sourceAgentId)`; never merged on `displayName`. `parentAgentId` only for `subagent`; `teamId` only for `lead` and `teammate`. `finishedAt` set by `agent.finished` (finished subagents are hidden by `status` unless `--all`) |
| Team | `id`, `leadAgentId`, `memberAgentIds[]`, `startedAt`, `endedAt?` | Members are the agents whose `teamId` equals the team ID, ordered by registration |
| Session | `id`, `agentId`, `sourceId`, `workingDirectory?`, `startedAt`, `endedAt?`, `provenance` | An agent may have several open sessions |
| ToolCall | `id`, `agentId`, `sessionId?`, `toolName`, `phase`, `filePaths[]`, `summary?`, `evidenceIds[]`, `startedAt`, `durationMs?` | Opened by `tool_call.started`, closed by `tool_call.finished` |
| Task | `id`, `title`, `status`, `assignedAgentIds[]`, `relatedTaskIds[]`, `updatedAt`, `transitionWarning?` | `assignedAgentIds` ordered by assignment time |
| AgentActivity | `agentId`, `sessionId?`, `taskId?`, `activity`, `heuristic`, `since`, `latestEvidence?`, `openSessionCount` | Primary activity = most recently started open session's activity |
| PendingRequest | `id`, `agentId`, `sessionId?`, `kind`, `toolName?`, `inputPreview?`, `reason?`, `answerable`, `openedAt`, `expiresAt?`, `state`, `late` | See "Requests and commands" |
| Command | `id`, `type`, `requestId`, `payload`, `status`, `idempotencyKey`, `updatedAt` | Projection of `command.*` events; none are emitted in this feature |
| Attention (derived, not stored) | `agentId`, `level`, `kind`, `reason?`, `since`, `requestId?`, `heuristic` | Output of the `attention(state, now)` selector; see "Attention rules" |

`reason` values in state are always the stored form `{ text, masked, truncated }`
(FR-017): masked by the redaction module, then cut to 280 characters.

**Bounded state (SC-006).** The projection keeps open ToolCalls plus the most
recent finished ToolCall per agent; older finished calls stay in the event log and
are served by the agent feed in M5. Counters (`toolCallCount`,
`consecutiveToolFailures`) carry what the reducer needs from the rest.

### Enumerations

- `Agent.kind`: `session`, `subagent`, `lead`, `teammate`
- `connection`: `connected`, `disconnected`, `unknown`
- `Task.status`: `queued`, `assigned`, `running`, `blocked`, `awaiting_input`,
  `reviewing`, `completed`, `failed`, `cancelled`, `unknown`
- `activity`: `idle`, `implementing`, `testing`, `reviewing`, `researching`,
  `documenting`, `dispatching`, `handing_off`, `waiting`, `unknown`
- `ToolCall.phase`: `running`, `succeeded`, `failed`
- `Attention.level`: `needs_you`, `trouble`, `waiting`
- `Attention.kind`: for `needs_you`, the request kind (`permission`, `elicitation`,
  `input`); for `trouble`, `stop_failure`, `tool_failures`, `silent`; for
  `waiting`, `turn_ended`, `idle_prompt`
- `PendingRequest.kind`: `permission`, `elicitation`, `input`
- `PendingRequest.state`: `open`, `answered_here`, `answered_elsewhere`, `expired`
- `Command.status`: `requested`, `delivered`, `succeeded`, `failed`, `expired`,
  `unsupported`
- `Agent.lastTurn`: `ended`, `failed`, `idle_prompt`

Any source value not in an enum is stored as `unknown` with the original preserved
in `sourceValue` (Principle IV). The attention, request, and command enums are
produced by the engine and the reducer, not taken from sources, so they have no
`unknown` member.

### Task state transitions

```text
queued -> assigned -> running <-> blocked
                       running <-> awaiting_input
                       running -> reviewing -> running | completed
any non-terminal -> failed | cancelled | unknown
terminal: completed, failed, cancelled
```

Transitions outside this graph (including leaving a terminal status) are applied,
because the source is the authority, but flagged with a `transitionWarning` on the
task so the UI can surface them later. Task statuses are task data only; they never
raise attention by themselves.

### Connection vs activity

`agent.disconnected` changes `connection` only. Activity, task, and attention are
retained. Nothing auto-fails on disconnect.

### Requests and commands

PendingRequest and Command are projections of `request.*` and `command.*` events;
there is no other way to change them (ARCHITECTURE.md section 6).

- `request.opened` creates a request in state `open`. `answerable` is true only
  when the event's `sourceId` is `taskville:bridge`, which only the engine's
  permission bridge (M4) can emit. Requests ingested through `POST /v1/events/batch`
  are always `answerable: false`, so a forged telemetry event can turn an agent red
  but never creates something to approve.
- **One prompt, one red state.** A `permission` request merges with an open
  `permission` request that has the same `sessionId`, `agentId`, and `toolName`:
  the existing record is kept, `answerable` becomes true if either is, and no
  second attention record appears. ARCHITECTURE.md section 2.2 keys the merge by
  session and tool; the agent is part of the key so that two subagents in one
  session asking for the same tool keep separate records (section 2.9). If spike
  S-2 shows that a `Notification` carries no subagent attribution, the M2 adapter
  attributes it before ingest; the reducer never guesses.
- A request closes as `answered_elsewhere` when the next event from the same
  session arrives (`tool_call.finished`, `session.turn_ended`,
  `session.turn_failed`, `session.prompt_submitted`, `session.ended`) and the
  request was not answered here. `request.resolved` (engine only) closes it as
  `answered_here` or `answered_elsewhere`; `request.expired` (engine only, emitted
  for every open request at engine start) closes it as `expired`.
- A `late` `request.opened` is recorded with `late: true` and state `expired`; it
  never opens a request and never produces `needs_you`.
- A Command moves through `requested -> delivered -> succeeded | failed | expired`
  or straight to `unsupported`, one `command.*` event per transition. Acknowledgment
  (`delivered`) is not completion. A command whose request is no longer `open` ends
  `failed`; one whose decision missed the still-open hook response (hold window
  ended) ends `expired` (ARCHITECTURE.md sections 6 and 9.2).

### Attention rules (selector `attention(state, now)`)

`now` is injected (engine clock live, replay clock in history). Attention is never
stored in reducer state and is not part of `stateHash`.

| Level | Kind | Raised when | Cleared when | Heuristic |
| --- | --- | --- | --- | --- |
| `needs_you` | request kind | An `open` PendingRequest exists for the agent; `requestId` set | The request leaves `open` | no |
| `trouble` | `stop_failure` | `session.turn_failed` is the agent's latest turn event | A later `session.prompt_submitted` or successful `tool_call.finished` | no |
| `trouble` | `tool_failures` | `consecutiveToolFailures >= 3` | A succeeded tool call resets the counter | no |
| `trouble` | `silent` | The agent is connected and not finished, holds no `needs_you` or `waiting` record, and `now - lastSeenAt` exceeds the threshold (default 10 min) | Any event from the agent | yes |
| `waiting` | `turn_ended` | `session.turn_ended` is the agent's latest turn event | Next prompt or tool call | no |
| `waiting` | `idle_prompt` | `session.idle_prompt` is the agent's latest turn event | Next prompt or tool call | no |

An agent can hold several records; `needs_you` sorts first, then `trouble`, then
`waiting`, each by `since` ascending. The `reason` of a `needs_you` record is the
request's stored `reason`; a heuristic record's reason is generated text such as
"quiet for 12 min" and is labeled heuristic.

## Storage schema (apps/engine/src/storage, SQLite)

Opened with the `node:sqlite` `Database` and `Statement` classes (not the
deprecated `*Sync` aliases), WAL mode, explicit `BEGIN IMMEDIATE` / `COMMIT`.

```text
schema_migrations(version INTEGER PK, applied_at TEXT)

projects(
  id TEXT PK, name TEXT NOT NULL, created_at TEXT NOT NULL,
  roots_json TEXT NOT NULL DEFAULT '[]',
  builtin INTEGER NOT NULL DEFAULT 0,
  head INTEGER NOT NULL DEFAULT 0)

events(
  project_id TEXT NOT NULL REFERENCES projects(id),
  ingest_sequence INTEGER NOT NULL,
  event_id TEXT NOT NULL UNIQUE,
  source_id TEXT NOT NULL,
  source_event_id TEXT NOT NULL,
  source_sequence INTEGER,
  occurred_at TEXT NOT NULL,
  received_at TEXT NOT NULL,
  type TEXT NOT NULL,
  schema_version INTEGER NOT NULL,
  provenance TEXT NOT NULL CHECK (provenance IN ('live','imported','demo')),
  content_hash TEXT NOT NULL,
  envelope_json TEXT NOT NULL,
  PRIMARY KEY (project_id, ingest_sequence),
  UNIQUE (project_id, source_id, source_event_id))

projections(
  project_id TEXT PK REFERENCES projects(id),
  reducer_version INTEGER NOT NULL,
  head INTEGER NOT NULL,
  state_hash TEXT NOT NULL,
  state_json TEXT NOT NULL)

pairings(
  id TEXT PK, secret_hash TEXT NOT NULL UNIQUE,
  created_at TEXT NOT NULL, last_used_at TEXT)
```

- `events` is insert-only; the engine has no UPDATE or DELETE statement for it.
- `projects.head` and `projections.head` are written in the same transaction as
  the events they cover, so `snapshot` returns `(state, head)` atomically.
- On boot, any project whose `projections.reducer_version` differs from the code's
  `REDUCER_VERSION` is rebuilt from `events` ordered by `ingest_sequence` before the
  HTTP server starts listening.
- The built-in Unsorted project (`id = 'unsorted'`, `builtin = 1`) is created at
  first boot with its `project.created` event, and cannot be removed.
- `pairings` stores only a SHA-256 of each browser session secret;
  `taskville unpair` deletes all rows.
- PendingRequest and Command projections live in `projections.state_json` in this
  feature. The `pending_requests` and `commands` tables listed in ARCHITECTURE.md
  section 7.4, and `checkpoints`, `archives`, and `settings`, are added by the
  milestones that need them (M4, M6, M8) and are written only by projection.
- Evidence bodies go to a separate `evidence.db` (M2.06), not this file.

## Validation rules (FR-001 to FR-019)

| Rule | Where |
| --- | --- |
| `schemaVersion === 1`, known `type`, payload matches type schema | protocol, at ingest |
| `projectId` names an existing project (added with `taskville project add`, or the built-in `unsorted`); otherwise `unknown_project` and nothing is created (FR-011) | engine ingest |
| `type` is not engine-only (`project.*`, `request.resolved`, `request.expired`, `command.*`); otherwise `engine_only_type` | engine ingest |
| `sourceId` does not start with `taskville:`; otherwise `reserved_source` | engine ingest |
| `sourceId`, `sourceEventId` non-empty, <= 200 chars | protocol |
| `occurredAt` ISO-8601 with offset | protocol |
| `provenance` must equal `demo` when `sourceId` starts with `demo:` and vice versa | engine ingest |
| Batch size <= 5,000 events, body <= 5 MB | engine http |
| Every payload string except IDs, enums, and timestamps (events.md "Masking") has control characters stripped and secrets masked before commit; `reason` is then cut to 280 characters and stored as `{ text, masked, truncated }` (FR-017); input `reason` longer than 4,000 characters is rejected as `invalid_payload` | protocol transform, engine ingest (redaction module, M1.20) |
| `content_hash` is computed over the client-supplied fields after masking but **before** the 280-character truncation (engine-assigned fields excluded). Two reasons that differ only after character 280 therefore hash differently and are a conflict, not a duplicate, while the unmasked text is never persisted in any form, not even as a hash input | engine ingest |
