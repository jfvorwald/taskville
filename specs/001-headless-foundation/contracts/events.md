# Contract: Event Protocol v1

Source of truth will be the Zod schemas in `packages/protocol`; this document is
the human-readable contract. Producers send **input events**; the engine returns
**stored envelopes** with engine-assigned fields added.

## Input event (what producers send)

| Field | Type | Required | Notes |
| --- | --- | --- | --- |
| `schemaVersion` | `1` | yes | Other values rejected: `unsupported_schema_version` |
| `projectId` | string | yes | |
| `sourceId` | string | yes | Stable producer identity, e.g. `demo:42`, `cli`, `adapter:generic` |
| `sourceEventId` | string | yes | Unique within the source; idempotency key with project and source |
| `sourceSequence` | integer | no | Same-source ordering tiebreak |
| `occurredAt` | ISO-8601 string | yes | When it happened at the source |
| `type` | string | yes | One of the types below |
| `agentId`, `sessionId`, `taskId`, `correlationId` | string | no | As relevant to the type |
| `payload` | object | yes | Per-type schema |
| `evidenceIds` | string[] | no | Default `[]`; evidence storage arrives in feature 005 |
| `provenance` | `live` \| `imported` \| `demo` | yes | |

## Stored envelope (what the engine returns and streams)

Input event plus: `eventId` (UUID), `receivedAt` (engine clock), `ingestSequence`
(per-project, gap-free, starts at 1).

## Event types in v1

| Type | Payload | Effect |
| --- | --- | --- |
| `project.created` | `{ name }` | Creates project if absent |
| `agent.registered` | `{ sourceAgentId, displayName, role }` | Creates or updates agent |
| `agent.connected` / `agent.disconnected` | `{}` | Connection state only |
| `session.started` | `{ }` (uses `agentId`, `sessionId`) | Opens session |
| `session.ended` | `{ outcome? }` | Closes session |
| `task.created` | `{ title, relatedTaskIds? }` | Task `queued` |
| `task.assigned` | `{ agentIds }` | Status `assigned` |
| `task.status_changed` | `{ status, reason? }` | Any status; unknown values become `unknown` |
| `task.handoff` | `{ fromAgentId, toAgentId, note? }` | Reassigns; activity `handing_off` on sender |
| `activity.started` | `{ activity }` | Sets primary activity |
| `activity.ended` | `{ }` | Activity returns to `idle` |
| `input.requested` | `{ reason }` | Attention on agent |
| `input.resolved` | `{ }` | Clears that attention |
| `test.result` | `{ passed, failed, skipped, summary? }` | Recorded as latest evidence on activity |

Command lifecycle, Git, and import event families are reserved for features 005
and 006 and are rejected as `unknown_type` in v1.

## Per-event ingest result

```json
{ "sourceEventId": "e-17", "status": "accepted", "ingestSequence": 42, "eventId": "..." }
{ "sourceEventId": "e-17", "status": "duplicate", "ingestSequence": 42, "eventId": "..." }
{ "sourceEventId": "e-18", "status": "conflict", "existingEventId": "..." }
{ "sourceEventId": "e-19", "status": "rejected", "error": { "code": "invalid_payload", "path": "payload.status", "message": "..." } }
```

Rejection codes: `unsupported_schema_version`, `unknown_type`, `invalid_envelope`,
`invalid_payload`, `unknown_project`, `provenance_mismatch`.

## JSONL file format (CLI ingest, fixtures)

One input event per line, UTF-8. Blank lines and lines starting with `//` are
ignored. Line numbers are reported with rejections.
