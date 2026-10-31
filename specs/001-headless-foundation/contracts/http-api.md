# Contract: HTTP and SSE API v1 (feature 001 subset)

Base URL `http://127.0.0.1:4807` (default port, configurable). JSON bodies,
UTF-8. Errors use `{ "error": { "code", "message" } }`. This is the subset of
ARCHITECTURE.md section 8 that feature 001 delivers; history, replay-state,
imports, and commands are later features.

## Auth

| Route class | Requirement |
| --- | --- |
| Write (`POST`) | `Authorization: Bearer <token from $TASKVILLE_HOME/token>`; else `401 unauthorized` |
| Any request with an `Origin` header | Origin must be in the allow-list (empty in feature 001); else `403 forbidden_origin` |
| Bind address | `127.0.0.1` only |

No `Access-Control-Allow-Origin: *` is ever sent.

## Endpoints

### `POST /v1/events/batch`

Request: `{ "events": InputEvent[] }` (max 5,000 events, 5 MB).
Response `200`: `{ "results": IngestResult[], "head": number }` per
[events.md](events.md). Partial success is still `200`; per-event status
carries the outcome. `400` only when the body itself is not a valid batch.
`413` when limits are exceeded.

### `GET /v1/projects`

Response: `{ "projects": [{ "id", "name", "head" }] }`

### `GET /v1/projects/:id/snapshot`

Response: `{ "projectId", "cursor": number, "reducerVersion", "stateHash", "state": ProjectState, "attention": AgentId[] }`.
`cursor` equals the `head` the state was computed at. `404 unknown_project`.

### `GET /v1/projects/:id/events?after=<cursor>` (SSE)

`Content-Type: text/event-stream`. `Last-Event-ID` header, if present, overrides `after`.

Frames:

```text
id: 43
event: event
data: <StoredEnvelope JSON>

event: heartbeat          (every 15 s, no id)
data: {"head":43}

event: resnapshot         (then the server closes the stream)
data: {"reason":"cursor_ahead_of_head" | "slow_consumer" | "reducer_rebuilt"}
```

Guarantees: backlog `after+1..head` is sent in ingest order before live events;
no gaps; no duplicates within one connection. `after > head` -> `resnapshot`.
Per-subscriber buffer 1,000 frames; on overflow -> `resnapshot` with
`slow_consumer` and close.

### `GET /health`

`200 { "status": "ok", "db": "ok", "walMode": true, "uptimeSeconds", "version" }`;
`503` with `db: "error"` when the database cannot be read.
