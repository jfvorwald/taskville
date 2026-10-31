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
  retired:   { agents, tasks, requests }      (counts dropped by retention)
```

| Entity | Fields | Rules |
| --- | --- | --- |
| Agent | `id`, `sourceId`, `sourceAgentId`, `displayName`, `role`, `kind`, `parentAgentId?`, `teamId?`, `connection`, `lastSeenAt`, `finishedAt?`, `toolCallCount`, `consecutiveToolFailures`, `lastTurn?` | Identity key is `(sourceId, sourceAgentId)`; never merged on `displayName`. `parentAgentId` only for `subagent`; `teamId` only for `lead` and `teammate`. `finishedAt` set by `agent.finished` (finished subagents are hidden by `status` unless `--all`) |
| Team | `id`, `leadAgentId`, `memberAgentIds[]`, `startedAt`, `endedAt?` | Members are the agents whose `teamId` equals the team ID, ordered by registration |
| Session | `id`, `agentId`, `sourceId`, `workingDirectory?`, `startedAt`, `endedAt?`, `provenance` | An agent may have several open sessions. Owned by the first agent that names it and may own one: a `subagent`, or an agent that runs inside another agent's session (Claude Code ID form `claude-code:<session>:<agent>`, such as in-process teammates and helpers, M2.13), never owns a session |
| ToolCall | `id`, `agentId`, `sessionId?`, `toolName`, `phase`, `filePaths[]`, `summary?`, `evidenceIds[]`, `startedAt`, `finishedAt?`, `durationMs?` | Opened by `tool_call.started`, closed by `tool_call.finished`, or closed `unfinished` by a later boundary (see "Unfinished tool calls") |
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

**Retention (M2.16, decision #202 D1 default).** Closed and finished records are
kept in the projection only while they are among the newest, so state stays bounded
however long a project runs. The event log keeps everything, and history (M6) reads
the log, not the projection. After every event, as the last step of `reduce`:

- **Finished agents** (`finishedAt` set) beyond the newest
  `RETAIN_FINISHED_AGENTS` (50), ordered by `finishedAt` then ID, are dropped. An
  agent is never dropped while an unfinished agent names it as `parentAgentId`,
  while it leads a team that has not ended, while it has an `open` request, or while
  it has a running tool call. Dropping an agent also drops its activity, its tool
  calls, the sessions it owns, and its place in team member lists.
- **Terminal tasks** (`completed`, `failed`, `cancelled`) beyond the newest
  `RETAIN_TERMINAL_TASKS` (50), ordered by `updatedAt` then ID, are dropped.
  Activity that names a dropped task keeps its `taskId`.
- **Closed requests** (state not `open`) beyond the newest `RETAIN_CLOSED_REQUESTS`
  (50), ordered by `openedAt` then ID, are dropped.
- `retired` counts what was dropped (`agents`, `tasks`, `requests`), so totals stay
  countable: totals are the kept records plus `retired`.

The rule reads only state, never a clock, so replay and a resumed checkpoint give
the same state and `stateHash`. An event that names a dropped record afterwards
(for example a very late event for a subagent dropped long ago) is applied like an
event for a record never seen: it creates a new record, and `retired` is unchanged.

**Unfinished tool calls (M2.13).** A `tool_call.started` may never get its
`tool_call.finished`: a permission denied by a hook or answered No in the terminal
fires no PostToolUse (spike S-1), and internal helper agents never do (S-2). Such a
call is closed with phase `unfinished` (never `succeeded` or `failed`) and
`finishedAt` set to the closing event's time, by the first of:

- the owning agent's own `session.turn_ended`, `session.turn_failed`,
  `session.prompt_submitted`, or `session.ended` in the call's session (or any of
  them, for a call with no session), or its `agent.finished`;
- for a call of an unregistered agent (never seen in `agent.registered`, as with
  helper agents): the same boundary events from the agent that owns the call's
  session;
- `session.ended` of the call's session, from any agent.

A registered agent's running call is never closed by another agent's turn (a
background subagent keeps running after its parent's Stop). Closing does not change
`toolCallCount` (counted at start) or `consecutiveToolFailures`, and does not clear
`lastTurn`. A later `tool_call.finished` for an `unfinished` call is applied: the
recorded result replaces `unfinished`. Retention is unchanged: an `unfinished`
call counts as finished, so the projection keeps at most
`MAX_OPEN_TOOL_CALLS_PER_AGENT` running calls plus the latest finished call per
agent; when one boundary closes several calls, the latest started one is kept.

### Enumerations

- `Agent.kind`: `session`, `subagent`, `lead`, `teammate`
- `connection`: `connected`, `disconnected`, `unknown`
- `Task.status`: `queued`, `assigned`, `running`, `blocked`, `awaiting_input`,
  `reviewing`, `completed`, `failed`, `cancelled`, `unknown`
- `activity`: `idle`, `implementing`, `testing`, `reviewing`, `researching`,
  `documenting`, `dispatching`, `handing_off`, `waiting`, `unknown`
- `ToolCall.phase`: `running`, `succeeded`, `failed`, `unfinished` (domain only: no result was recorded before a boundary closed it; never an input value)
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
  attributes it before ingest; the reducer never guesses. A request without a
  `sessionId` never merges.
- A request closes as `answered_elsewhere` when the next event from the same
  session arrives (`tool_call.finished`, `session.turn_ended`,
  `session.turn_failed`, `session.prompt_submitted`, `session.ended`) and the
  request was not answered here. For a telemetry request (not answerable), decision
  #184 D1 (default) narrows this: `tool_call.finished` and `session.turn_failed`
  close it only when they come from the agent that owns the request;
  `session.turn_ended`, `session.prompt_submitted`, and `session.ended` close it
  from any agent in the session. Subagents and in-process teammates share their
  lead's session (S-2), so this keeps a subagent's unrelated tool call from closing
  its lead's prompt. A bridge-held request is never closed by a same-session
  event (decision #116): only the engine closes it, from a matching PostToolUse or a
  closed hook (M4), `request.resolved`, or `request.expired`. `request.resolved` (engine only) closes it as
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
| `waiting` | `turn_ended` | `session.turn_ended` is the agent's latest turn event, and the agent is not a `teammate` (a teammate's turn ending means idle, not waiting on you; M2.13) | Next prompt or tool call | no |
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
