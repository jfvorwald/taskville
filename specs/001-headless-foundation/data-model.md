# Data Model: Headless Foundation

Derived from [spec.md](spec.md) Key Entities and ARCHITECTURE.md section 5. Two
layers: the **domain state** produced by the pure reducer, and the **storage
schema** that persists events and projections.

## Domain state (packages/domain)

```text
ProjectState
  projectId, reducerVersion, head (last ingestSequence applied)
  agents:   Map<AgentId, Agent>
  sessions: Map<SessionId, Session>
  tasks:    Map<TaskId, Task>
  activity: Map<AgentId, AgentActivity>
```

| Entity | Fields | Rules |
| --- | --- | --- |
| Agent | `id`, `sourceId`, `sourceAgentId`, `displayName`, `role`, `connection`, `lastSeenAt` | Identity key is `(sourceId, sourceAgentId)`; never merged on `displayName` |
| Session | `id`, `agentId`, `sourceId`, `startedAt`, `endedAt?`, `provenance` | An agent may have several open sessions |
| Task | `id`, `title`, `status`, `assignedAgentIds[]`, `relatedTaskIds[]`, `updatedAt` | `assignedAgentIds` ordered by assignment time |
| AgentActivity | `agentId`, `sessionId?`, `taskId?`, `activity`, `since`, `attention?`, `latestEvidence?`, `openSessionCount` | Primary activity = most recently started open session's activity |
| Attention | `kind: "awaiting_input" \| "blocked"`, `reason`, `since`, `taskId?` | Derived from task status or explicit input-request event |

### Enumerations

- `connection`: `connected`, `disconnected`, `unknown`
- `Task.status`: `queued`, `assigned`, `running`, `blocked`, `awaiting_input`,
  `reviewing`, `completed`, `failed`, `cancelled`, `unknown`
- `activity`: `idle`, `implementing`, `testing`, `reviewing`, `researching`,
  `documenting`, `handing_off`, `waiting`, `unknown`

Any value not in an enum is stored as `unknown` with the original preserved in
`sourceValue` (Principle IV).

### Task state transitions

```text
queued -> assigned -> running <-> blocked
                       running <-> awaiting_input
                       running -> reviewing -> running | completed
any non-terminal -> failed | cancelled | unknown
terminal: completed, failed, cancelled (a later event may reopen only via an explicit task.reopened)
```

Transitions outside this graph are applied (the source is the authority) but
flagged with a `transitionWarning` on the task so the UI can surface them later.

### Connection vs activity

`agent.disconnected` changes `connection` only. Activity, task, and attention are
retained. Nothing auto-fails on disconnect.

### Attention rule (selector `needsAttention`)

An agent needs attention when any assigned task is `awaiting_input` or `blocked`,
or an `input.requested` event is open for it. The reason is the most recent such
event's `reason` field (bounded to 280 characters).

## Storage schema (apps/engine/src/storage, SQLite)

```text
schema_migrations(version INTEGER PK, applied_at TEXT)

projects(
  id TEXT PK, name TEXT NOT NULL, created_at TEXT NOT NULL,
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
```

- `events` is insert-only; the engine has no UPDATE or DELETE statement for it.
- `projects.head` and `projections.head` are written in the same transaction as
  the events they cover, so `snapshot` returns `(state, head)` atomically.
- On boot, any project whose `projections.reducer_version` differs from the code's
  `REDUCER_VERSION` is rebuilt from `events` ordered by `ingest_sequence` before the
  HTTP server starts listening.

## Validation rules (from FR-001 to FR-016)

| Rule | Where |
| --- | --- |
| `schemaVersion === 1`, known `type`, payload matches type schema | protocol, at ingest |
| `projectId` exists or batch creates it via `project.created` | engine ingest |
| `sourceId`, `sourceEventId` non-empty, <= 200 chars | protocol |
| `occurredAt` ISO-8601 with offset | protocol |
| `provenance` must equal `demo` when `sourceId` starts with `demo:` and vice versa | engine ingest |
| Batch size <= 5,000 events, body <= 5 MB | engine http |
| Free-text fields (reason, title) bounded; control characters stripped | protocol transform |
