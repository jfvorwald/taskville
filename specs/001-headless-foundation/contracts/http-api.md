# Contract: HTTP and SSE API v1 (feature 001 subset)

Base URL `http://127.0.0.1:4807` (default port, configurable). JSON bodies,
UTF-8. Errors use `{ "error": { "code", "message" } }`. This is the subset of
ARCHITECTURE.md section 10 that feature 001 delivers, plus the pairing and project
routes that sections 13 and FR-011 need. Built on Hono 4 with `@hono/node-server`;
the checks below are middleware applied to every route, in the order listed.

## Security (ARCHITECTURE.md section 13, FR-014)

Checks run on **every** route, reads included, before any handler:

| # | Check | Failure |
| --- | --- | --- |
| 1 | Bind address is `127.0.0.1` only; `serve` refuses any other host | startup error |
| 2 | `Host` header is exactly `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding) | `403 forbidden_host` |
| 3 | If an `Origin` header is present, it equals `http://127.0.0.1:<port>` or `http://localhost:<port>`. State-changing routes (`POST`) authenticated by a browser session must carry a matching `Origin` | `403 forbidden_origin` |
| 4 | A credential is present and valid (see below). Only `POST /v1/pairing` is exempt; it takes a pairing code instead | `401 unauthorized` |
| 5 | The credential kind is allowed on this route (table below) | `403 credential_not_allowed` |

Credentials:

| Kind | Sent as | Source | Notes |
| --- | --- | --- | --- |
| CLI token | `Authorization: Bearer <token>` | `$TASKVILLE_HOME/token` (mode 0600, 256-bit, created on first `serve`) | Used by the CLI, the demo producer, and the telemetry shim (M2) |
| Bridge token | `Authorization: Bearer <token>` | `$TASKVILLE_HOME/bridge-token` (mode 0600) | Accepted only on `POST /v1/bridge/claude-code/permission` (M4). Not used in this feature |
| Browser session | `X-Taskville-Session: <secret>` | Returned by `POST /v1/pairing` | Kept by the page in `localStorage`; stored by the engine only as a hash |

No cookies: the engine never sends `Set-Cookie` and ignores any `Cookie` header.
No `Access-Control-Allow-Origin` header is ever sent; the web client is served from
the same origin (M3). SSE streams are read with `fetch` streaming so they can carry
the credential header; `EventSource` is not supported.

Route access:

| Route | CLI token | Browser session | Bridge token |
| --- | --- | --- | --- |
| `GET /health`, `GET /v1/projects`, `GET /v1/projects/:id/snapshot`, `GET /v1/projects/:id/events`, `GET /v1/attention/events` | yes | yes | no |
| `POST /v1/events/batch`, `POST /v1/projects`, `POST /v1/pairing/revoke` | yes | no | no |
| `POST /v1/commands`, `GET /v1/commands/:id` | **never** | yes | **never** |
| `POST /v1/pairing` | no credential; pairing code in body | | |

The CLI, shim, and bridge tokens can never authorize a command (ARCHITECTURE.md
section 9.2): the supervised agent runs as the same OS user and can read the token
files.

## Endpoints

### `POST /v1/pairing`

`taskville serve` prints a one-time URL `http://127.0.0.1:<port>/#pair=<code>`
(256-bit random code, in the fragment so it never reaches request logs). The page
posts `{ "code" }` and receives `200 { "session": "<secret>" }` (256-bit). The code
is single-use and valid for 10 minutes after `serve` issues it (`PAIRING_CODE_TTL_MS`,
security review #17 F4); a reused, expired or unknown code gets
`401 invalid_pairing_code`, and a new code needs a `serve` restart (decision #163).
Requires a matching `Origin`. A pairing survives page reloads until revoked. Whether
it survives engine restarts is decision #113; until it is answered, pairings are kept
in memory and a restart means pairing again.

### `POST /v1/pairing/revoke`

Revokes every browser session (`taskville unpair`). Response `200 { "revoked": n }`.

### `POST /v1/projects`

Request: `{ "id"?, "name", "roots": string[] }`. `id` defaults to a slug of
`name`; `roots` are absolute directory paths. The engine creates the project and
its `project.created` event (sequence 1) in one transaction. `409 project_exists`
if the ID is taken, including `unsorted`. Response `201 { "id", "name", "roots",
"head": 1 }`. See research.md R-12 for where projects are declared.

### `POST /v1/events/batch`

Request: `{ "events": InputEvent[] }` (max 5,000 events, 5 MB).
Response `200`: `{ "results": IngestResult[], "heads": { "<projectId>": number } }` per
[events.md](events.md). Partial success is still `200`; per-event status
carries the outcome. `400` only when the body itself is not a valid batch.
`413` when limits are exceeded.

### `GET /v1/projects`

Response: `{ "projects": [{ "id", "name", "roots", "builtin", "head" }] }`. The
built-in `unsorted` project is always listed.

### `GET /v1/projects/:id/snapshot`

Response: `{ "projectId", "cursor": number, "reducerVersion", "stateHash", "state": ProjectState, "attention": Attention[], "computedAt" }`.
`cursor` equals the `head` the state was computed at. `state` and `stateHash` are
the stored projection. `attention` is the output of the `attention(state, now)`
selector at `computedAt` (engine clock); it is not part of `stateHash`.
`404 unknown_project`.

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
Hono's `streamSSE` has no write cap, so the engine keeps its own per-subscriber
queue of 1,000 frames; on overflow -> `resnapshot` with `slow_consumer` and close.
Other subscribers are unaffected. A cut-off client that has not read the final
`resnapshot` frame within 5 s is aborted. At most 64 streams are open at once;
above that the route answers `503 too_many_streams`. Revoking pairings
(`POST /v1/pairing/revoke`) ends every stream opened with a browser session
(security review #17, F1 and F5).

### `GET /v1/attention/events` (SSE, M4.01)

The global attention feed: which projects have an agent that needs you or is in
trouble, whichever project a client is viewing. `Content-Type: text/event-stream`.
CLI token or paired browser session; the bridge token gets `403 credential_not_allowed`.
No CORS headers. Counts toward the same 64-stream cap (`503 too_many_streams`), and
revoking pairings ends a feed opened with a browser session.

```text
event: snapshot           (first frame, no id)
data: {"projects":[{"projectId","name","attention":Attention[]}],"computedAt"}

event: attention          (a project's set changed, no id)
data: {"projectId","name","attention":Attention[],"computedAt"}

event: heartbeat          (every 15 s, no id)
data: {}
```

`attention` holds only the `needs_you` and `trouble` records of the domain
`attention(state, now)` selector at `computedAt` (engine clock), never `waiting`;
silence-based trouble keeps `heuristic: true`. The snapshot lists only projects with
at least one such record. An `attention` frame with an empty array means the project
cleared. A frame is sent only when the set of records changes (agent, level, kind,
request ID); a change in reason text alone sends nothing. The engine recomputes on
each commit and on a timer (30 s by default, `BootOptions.attentionTickMs`) so
silence appears without an event. Frames carry no `id` and the feed is not resumable:
a reconnect starts with a fresh snapshot, which replaces what the client held. A client
that stops reading fills its 1,000 frame queue and is disconnected.

### `POST /v1/commands`, `GET /v1/commands/:id` (stub in this feature)

Registered with the full security middleware so the credential rules are tested
now. A request with any token gets `403 credential_not_allowed`. A paired browser
session with a matching `Origin` gets `501 not_implemented` until the command
service lands in M4. No side effects.

### `GET /health`

`200 { "status": "ok", "db": "ok", "walMode": true, "uptimeSeconds", "version" }`;
`503` with `db: "error"` when the database cannot be read.

## Later routes (ARCHITECTURE.md section 10, not in this feature)

`POST /v1/sources/claude-code/hooks` (M2),
`POST /v1/bridge/claude-code/permission` (M4), `GET /v1/agents/:id/feed` and
`GET /v1/agents/:id/crew` (M5), `GET /v1/evidence/:id` (M2.06), timelines (M6),
imports (M8), OTLP (M5.12). Each inherits the security checks above.
