# Contract: Event Protocol v1

Source of truth will be the Zod schemas in `packages/protocol` (M1.05); this
document is the human-readable contract. It follows ARCHITECTURE.md sections 6 and
7. Producers send **input events**; the engine returns **stored envelopes** with
engine-assigned fields added. Entity rules are in [data-model.md](../data-model.md).

## Input event (what producers send)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | yes | Other values rejected: `unsupported_schema_version` |
| `projectId` | string | yes | Must name an existing project, else `unknown_project` (FR-011). For the Claude Code source (M2) the engine assigns it from the working directory instead |
| `sourceId` | string | yes | Stable producer identity, e.g. `demo:42`, `cli`, `adapter:generic`, `claude-code`, `git:<repo>`. The prefix `taskville:` is reserved for the engine |
| `sourceEventId` | string | yes | Unique within the source; idempotency key with project and source |
| `sourceSequence` | integer | no | Same-source ordering tiebreak |
| `occurredAt` | ISO-8601 string | yes | When it happened at the source |
| `type` | string | yes | One of the types below |
| `agentId`, `sessionId`, `taskId`, `correlationId` | string | no | As relevant to the type |
| `payload` | object | yes | Per-type schema |
| `evidenceIds` | string[] | no | Default `[]`. Stored and passed through; the evidence store that resolves them is M2.06 (`evidence.db`) |
| `provenance` | `live` \| `imported` \| `demo` | yes | |
| `late` | boolean | no | Default `false`. Set to `true` by the engine for events ingested from the telemetry spool (M2.07). Late events update history and agent records but never open `needs_you` |

## Stored envelope (what the engine returns and streams)

Input event plus: `eventId` (UUID), `receivedAt` (engine clock), `ingestSequence`
(per-project, gap-free, starts at 1). Fields marked **Text** below are stored in
their normalized form: control characters stripped and secrets masked by the
redaction module (M1.20). `reason` is additionally cut to 280 characters and
stored as `{ "text", "masked": boolean, "truncated": boolean }` (FR-017). The
unmasked input is never stored.

## Event types in v1

"Sender" says who may emit the type. **Any** means any producer through
`POST /v1/events/batch`. **Engine** means only the engine itself, with a
`taskville:*` source ID; the batch route rejects these types with
`engine_only_type`.

| Type | Payload | Effect | Sender |
| --- | --- | --- | --- |
| `project.created` | `{ name, roots: string[], builtin: boolean }` | First event of every project (sequence 1). Emitted by `POST /v1/projects` and once for the built-in Unsorted project | Engine |
| `agent.registered` | `{ sourceAgentId, displayName, role, kind, parentAgentId?, teamId? }` | Creates or updates the agent. `kind` is `session`, `subagent`, `lead`, or `teammate`; `parentAgentId` only with `subagent`, `teamId` only with `lead` or `teammate`. Identity `(sourceId, sourceAgentId)` never changes | Any |
| `agent.connected` / `agent.disconnected` | `{}` | Connection state only | Any |
| `agent.finished` | `{ outcome?, summary? (Text) }` | Sets `finishedAt` (subagent stopped, teammate left). Finished subagents are hidden by `status` unless `--all` | Any |
| `team.started` | `{ teamId, leadAgentId, name? }` | Creates the team | Any |
| `team.ended` | `{ teamId }` | Sets `endedAt` | Any |
| `session.started` | `{ workingDirectory? }` (uses `agentId`, `sessionId`) | Opens a session | Any |
| `session.ended` | `{ outcome? }` | Closes the session | Any |
| `session.prompt_submitted` | `{}` | User sent a prompt; clears `waiting` and `stop_failure` | Any |
| `session.turn_ended` | `{}` | Turn ended (`Stop`); `waiting` / `turn_ended` | Any |
| `session.turn_failed` | `{ reason? (Text) }` | Turn failed (`StopFailure`); `trouble` / `stop_failure` | Any |
| `session.idle_prompt` | `{}` | Idle notification; `waiting` / `idle_prompt` | Any |
| `task.created` | `{ title (Text), relatedTaskIds? }` | Task `queued` | Any |
| `task.assigned` | `{ agentIds }` | Status `assigned` | Any |
| `task.status_changed` | `{ status, reason? (Text) }` | Any status; unknown values become `unknown` | Any |
| `task.handoff` | `{ fromAgentId, toAgentId, note? (Text) }` | Reassigns; activity `handing_off` on sender | Any |
| `activity.started` | `{ activity, heuristic? }` | Sets primary activity. `heuristic: true` when the activity was guessed (for example a Bash command that looks like a test run) | Any |
| `activity.ended` | `{}` | Activity returns to `idle` | Any |
| `tool_call.started` | `{ toolCallId, toolName, filePaths?, summary? (Text) }` | ToolCall `running` | Any |
| `tool_call.finished` | `{ toolCallId, phase: "succeeded" \| "failed", durationMs?, summary? (Text) }` | Closes the ToolCall; updates `consecutiveToolFailures` | Any |
| `request.opened` | `{ requestId, kind: "permission" \| "elicitation" \| "input", toolName?, inputPreview? (Text, max 2,000 chars), reason? (Text), expiresAt? }` | PendingRequest `open`; agent `needs_you`. Answerable only when the source is `taskville:bridge` (M4). Merged with an open permission request of the same session and tool | Any (never answerable); bridge (answerable) |
| `request.resolved` | `{ requestId, resolution: "answered_here" \| "answered_elsewhere" }` | Closes the request | Engine |
| `request.expired` | `{ requestId }` | Closes the request as `expired` (emitted at engine start for every open request) | Engine |
| `command.requested` | `{ commandId, commandType, requestId, payload, idempotencyKey }` | Command `requested` | Engine |
| `command.delivered` / `command.succeeded` / `command.expired` / `command.unsupported` | `{ commandId }` | Command status | Engine |
| `command.failed` | `{ commandId, reason }` | Command `failed` | Engine |
| `test.result` | `{ passed, failed, skipped, summary? (Text) }` | Recorded as latest evidence on activity | Any |
| `git.commit` | `{ repo, sha, parents: string[], subject? (Text) }` | Recorded; no state effect in this feature | Any |
| `git.ref_moved` | `{ repo, ref, from?, to }` | Recorded; no state effect in this feature | Any |
| `git.merge` | `{ repo, sha, parents: string[] }` | Recorded; drives the merge celebration in M3 | Any |

Command types (`commandType`) in the first release are `permission.decide` and
`session.open` (ARCHITECTURE.md section 9.2). No command events are emitted in this
feature because the command service is M4, but the schemas and their projection
exist so M4 adds no new event types.

A request closes as `answered_elsewhere` without any `request.resolved` event when
the next event from the same session arrives (see data-model.md "Requests and
commands").

## Per-event ingest result

```json
{ "sourceEventId": "e-17", "status": "accepted", "ingestSequence": 42, "eventId": "..." }
{ "sourceEventId": "e-17", "status": "duplicate", "ingestSequence": 42, "eventId": "..." }
{ "sourceEventId": "e-18", "status": "conflict", "existingEventId": "..." }
{ "sourceEventId": "e-19", "status": "rejected", "error": { "code": "invalid_payload", "path": "payload.status", "message": "..." } }
```

Rejection codes: `unsupported_schema_version`, `unknown_type`, `invalid_envelope`,
`invalid_payload`, `unknown_project`, `provenance_mismatch`, `engine_only_type`,
`reserved_source`.

## JSONL file format (CLI ingest, fixtures)

One input event per line, UTF-8. Blank lines and lines starting with `//` are
ignored. Line numbers are reported with rejections.
