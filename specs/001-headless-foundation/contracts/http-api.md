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
| `GET /health`, `GET /v1/projects`, `GET /v1/projects/:id/snapshot`, `GET /v1/projects/:id/events` | yes | yes | no |
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

### `POST /v1/commands`, `GET /v1/commands/:id` (M4.03)

Registered with the full security middleware. A request with any token gets `403
credential_not_allowed`; a paired browser session needs a matching `Origin`. Until the command
service registers its routes (`registerCommandRoutes`; `taskville serve` wires it in M4.04) the
paths answer `501 not_implemented` with no side effects.

Request bodies are strict: an unknown key at any level is `400 bad_request`, and a body over 16 KiB
is `413 payload_too_large`. Every body carries `projectId`, `requestId`, and `idempotencyKey`, and
an optional `context: { "mode": "live" | "history" }`. A `history` context is
`400 history_context_rejected`, checked before anything else happens (a repeated key cannot bypass
it).

- `{ "type": "permission.decide", ..., "decision": { "behavior": "allow" } | { "behavior": "deny",
  "message"? } }`. `message` is passed to the agent (a default note when absent) and is not
  recorded in the log; the audit payload keeps the behavior only.
- `{ "type": "session.open", ..., "sessionId" }`. The working directory is read from the recorded
  session (`session.started` `workingDirectory`), never from the body, and the opener template
  comes only from the engine config. A body with `cwd`, `template`, or `sessionOpener` is
  `400 bad_request`.

Success is `200 { "command": { "id", "type", "requestId", "status", "result"? } }`.
`permission.decide` ends `delivered` ("sent, unconfirmed", decision #116 D4): the engine records
`command.requested`, `request.resolved` (`answered_here`, with `decision`), and `command.delivered`,
and never `command.succeeded` (M4.04 owns confirmation from telemetry). `session.open` ends
`succeeded` with `result: { "outcome": "opened" | "copy-only", "sessionId", "cwd"? }` (events:
`command.requested`, `command.delivered`, `command.succeeded`).

Errors are `{ "error": { "code", "message" }, "command"?: { "id", "type", "requestId", "status" } }`.
A `command` is present when the command was recorded.

| Status | Code | When | Recorded |
| --- | --- | --- | --- |
| 400 | `bad_request` | invalid body or JSON | nothing |
| 400 | `history_context_rejected` | `context.mode` is `history` | nothing |
| 404 | `unknown_project`, `unknown_request`, `unknown_session` | the target does not exist | nothing |
| 409 | `request_not_open` | the recorded request is already closed (checked without asking the bridge) | requested, failed |
| 422 | `not_answerable` | the request was not bridge-held | requested, unsupported |
| 410 | `request_expired` | the bridge no longer holds the request, or the decision reached no open hook response | requested, expired |
| 409 | `idempotency_conflict` | the key was used for a different command | nothing |
| 409 | `command_in_flight` | an opener is already running for the session (any key) | nothing |
| 502 | `opener_failed` | the opener could not be started or its directory is not a directory; the message is non-secret | requested, failed |

The same `idempotencyKey` with the same command returns the same command and status and does not
ask the bridge or run the opener again. A `GET /v1/commands/:id` for a paired session returns
`200 { "command" }` or `404 unknown_command`.

### `POST /v1/bridge/claude-code/permission` (M4.02)

The Claude Code `PermissionRequest` `http` hook (ARCHITECTURE.md 8.1). Accepts the bridge token
only (`bridge` scope); the CLI token and a paired browser session get `403
credential_not_allowed`. The body is the raw hook JSON; a body that is not a JSON object with a
`session_id` and a `tool_name` is `400 bad_request`. A body over 1 MiB is `413 payload_too_large`.
The project comes from the hook's `cwd`. The `agentId` is the adapters' attribution, as telemetry
records it: `claude-code:<session_id>` for the lead and `claude-code:<session_id>:<agent_id>` for a
child agent (subagent or teammate). A hook whose `session_id` or `agent_id` is not a valid hook ID
gets the empty `2xx` and nothing is recorded. A `prompt_id` that is not a valid hook ID (as
telemetry validates it, at most 100 characters) is treated as absent: no `correlationId`, and the
same absent value in the `PostToolUse` match.

The engine records `request.opened` (source `taskville:bridge`, answerable) and holds the response
while a viewer is connected on the project, for `bridge.holdWindowSeconds` (default 90). Answers:

- City decision within the window: `200` with the hook JSON, `{ "hookSpecificOutput": {
  "hookEventName": "PermissionRequest", "decision": { "behavior": "allow" } } }` or the same with
  `{ "behavior": "deny", "message": "..." }`.
- Window over, no viewer connected, or engine shutdown: `200` with an empty body, so Claude Code
  falls through to its own dialog. With no viewer the request is still recorded (the agent turns
  red) under the source `taskville:bridge-unheld`, so it is never answerable. A request that fell
  through stays open until a matching `PostToolUse` closes it or the next engine start expires it.
- Over a cap: at most 64 responses are held at once and a held request's serialized input is at
  most 256 KiB (262,144 UTF-8 bytes). A request over either cap is recorded unheld (source
  `taskville:bridge-unheld`) and answered at once with the empty `2xx`.
- Hook connection closed by Claude Code before any city answer: recorded as
  `request.resolved { resolution: "answered_elsewhere", decision: "deny" }` (decision #116 D2).

After fall-through the request stays open and unanswerable: the bridge no longer holds it, so a
later city decision cannot reach Claude Code (decision #271).

A matching `PostToolUse` (exactly one request with the same session, prompt, agent, tool name, and
input) closes the request as `answered_elsewhere` with `decision: "allow"` (decision #116 D3).
The exact tool input stays in memory for the decision card; events carry the masked copy.

### `GET /health`

`200 { "status": "ok", "db": "ok", "walMode": true, "uptimeSeconds", "version" }`;
`503` with `db: "error"` when the database cannot be read.

## Later routes (ARCHITECTURE.md section 10, not in this feature)

`GET /v1/attention/events` (M4.01), `POST /v1/sources/claude-code/hooks` (M2),
`GET /v1/agents/:id/feed` and
`GET /v1/agents/:id/crew` (M5), `GET /v1/evidence/:id` (M2.06), timelines (M6),
imports (M8), OTLP (M5.12). Each inherits the security checks above.
