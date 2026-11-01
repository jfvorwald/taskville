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
| Bridge token | `Authorization: Bearer <token>` | `$TASKVILLE_HOME/bridge-token` (mode 0600) | Accepted only on `POST /v1/bridge/claude-code/permission` (M4.02). The installed hook reads it from the `TASKVILLE_BRIDGE_TOKEN` variable (`allowedEnvVars`); it is never written to settings or printed |
| Browser session | `X-Taskville-Session: <secret>` | Returned by `POST /v1/pairing` | Kept by the page in `localStorage`; stored by the engine only as a hash |

No cookies: the engine never sends `Set-Cookie` and ignores any `Cookie` header.
No `Access-Control-Allow-Origin` header is ever sent; the web client is served from
the same origin (M3). SSE streams are read with `fetch` streaming so they can carry
the credential header; `EventSource` is not supported.

Route access:

| Route | CLI token | Browser session | Bridge token |
| --- | --- | --- | --- |
| `GET /health`, `GET /v1/projects`, `GET /v1/projects/:id/snapshot`, `GET /v1/projects/:id/events`, `GET /v1/projects/:id/timelines`, `GET /v1/timelines/:id/state`, `GET /v1/timelines/:id/events`, `GET /v1/attention/events`, `GET /v1/agents/:id/feed`, `GET /v1/agents/:id/crew`, `GET /v1/evidence/:id` | yes | yes | no |
| `POST /v1/events/batch`, `POST /v1/projects`, `POST /v1/pairing/revoke` | yes | no | no |
| `POST /v1/commands`, `GET /v1/commands/:id`, `GET /v1/requests/:requestId/input` | **never** | yes | **never** |
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
Requires a matching `Origin`. A pairing survives page reloads until revoked. A pairing
also survives engine restarts (decision #113, closed: pairings persist). Issue #198 is open
about sessions not minted by the run the human started.

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

### Timelines (M6.01)

History mode reads a project's recorded past. Today a project has one timeline, its live
recording, with ID `live:<projectId>`. Archive timelines arrive with imports (M8). The routes are
read routes: the CLI token and a paired browser session may use them, the bridge token gets `403
credential_not_allowed`, and they send no CORS headers. They offer no write method, never write
to the event log or the projections, and have no path to the command service. A timeline ID that is
not `live:<projectId>` is `404 not_found`; `live:<unknown project>` is `404 unknown_project`.

A **position** (`at`, `from`, `to`) is either a decimal ingest sequence (digits only: no sign,
fraction, exponent or hex) or a full ISO 8601 timestamp with a zone (`2026-01-01T12:00:00Z`,
`...+02:00`). The grammar is strict: `YYYY-MM-DDTHH:MM[:SS[.fraction]]` then `Z` or `+HH:MM` or
`-HH:MM`, upper-case `T` and `Z`, every field in range. Hour 24 (`T24:00`), minute or second 60,
an offset past 23:59, a space for the `T` and lower-case `t` or `z` are `400 bad_request`, as are
date-only, unzoned and any other form. A fraction finer than a millisecond is honored: a lower
bound (`from`) rounds up to the next whole millisecond, an upper bound (`at`, `to`) down. The live
timeline's clock is each event's `receivedAt`.

#### `GET /v1/projects/:id/timelines`

`200 { "projectId", "timelines": [{ "id": "live:<projectId>", "kind": "live", "projectId",
"firstSequence", "lastSequence", "firstAt", "lastAt", "eventCount" }] }`. `firstSequence` and
`lastSequence` are 1 and the head; `firstAt` and `lastAt` are those events' `receivedAt`;
`eventCount` equals `lastSequence`. `404 unknown_project`.

#### `GET /v1/timelines/:id/state?at=<position>`

`200 { "timelineId", "at", "cursor", "reducerVersion", "stateHash", "state", "attention",
"computedAt" }`. A sequence is that sequence; a timestamp is the greatest sequence received at or
before it. `at` in the response is the resolved sequence and `cursor` equals it. `state` and
`stateHash` equal a full replay of events 1 to `at`. `attention` is evaluated at the `receivedAt`
of event `at` (the engine clock for position 0), not at the engine clock, so history never calls
an agent silent because time has passed since; `computedAt` is the engine clock. Sequence 0 or a
timestamp before the first event is the empty state at 0; a position past the head resolves to the
head. A missing or malformed `at` is `400 bad_request`.

#### `GET /v1/timelines/:id/events?from=&to=&limit=&cursor=`

`200 { "timelineId", "events": StoredEnvelope[], "nextCursor": string | null }`: stored envelopes
in ascending ingest order. `from` and `to` are inclusive positions, defaulting to 1 and the head
when the request is served. A sequence `from` of 0 means 1; a sequence `to` past the head means
the head; a timestamp `from` is the first event received at or after it and a timestamp `to` the
last received at or before it. An empty range is `200` with no events. `limit` is an integer from
1 to 1000 (default 200), else `400 bad_request`. `nextCursor` is opaque and `null` on the last
page. Sending it back, with the same `from`, `to` and `limit`, returns the next page with no gap
and no duplicate; it supersedes `from`. The cursor always pins the end of the walk as resolved on
the first request (the explicit `to`, else the head at that moment), so pages stay within it and
do not change as events are ingested; a fresh request without a cursor sees the new head. An end
above the head (a forged cursor) is clamped to the head, and the page that reaches the head has
`nextCursor: null`, never an extra empty page. A malformed cursor, one whose content has the wrong
shape, or one issued for another timeline is `400 bad_request`.

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

### Agent feed, crew, and evidence (M5.01)

Three read routes (ARCHITECTURE.md 2.9, 2.10 and 10). CLI token or paired browser session; the
bridge token gets `403 credential_not_allowed`, no credential `401`. No CORS headers, `Cache-Control:
no-store`. Agent IDs and evidence IDs are opaque strings, URL-encoded in the path.

Which project: an agent is found by its events. Without `?projectId=`, exactly one project may hold
the agent; when several do (one session whose working directory moved), the request is `409
ambiguous_agent` and names no project. `?projectId=` names one: unknown project is `404
unknown_project`, a project that has no events for the agent is `404 unknown_agent` (the same answer
as an agent that exists nowhere). An agent ID that is not found, or was crafted, is `404
unknown_agent`; it is never read as a path or query.

#### `GET /v1/agents/:id/feed?after=N&projectId=P` (SSE)

The ToolCalls of one agent. `Content-Type: text/event-stream`. Resumes like the project stream:
`Last-Event-ID` overrides `after`, a malformed cursor is `400 bad_request`, a cursor past the
project head is one `resnapshot` frame (`cursor_ahead_of_head`) and the stream closes. Counts toward
the same 64-stream cap (`503 too_many_streams`), ends with the engine, and a feed opened with a
browser session ends when pairings are revoked. A client that stops reading is cut off with
`resnapshot` / `slow_consumer` (1,000 frames queued), and a write the client has not taken within
5 s aborts the stream.

```text
id: 57
event: toolcall
data: <ToolCall frame>

event: heartbeat          (once the backlog is sent, then every 15 s, no id)
data: {"head":57}

event: resnapshot         (then the server closes the stream)
data: {"reason":"cursor_ahead_of_head" | "slow_consumer"}
```

One `toolcall` frame per change of a ToolCall: a `PreToolUse` makes a `running` frame and its
`PostToolUse` a second frame for the same `toolCallId`. The frame `id` is the ingest sequence of the
event behind it, so frame ids rise in order but are not consecutive, and a client resumes with
`?after=<last id>`. A repeated start or finish changes nothing and sends no frame. Backlog and live
frames are gap-free and duplicate-free within a connection. The frame is the ToolCall as of that
event; a call whose finish never arrives stays `running`, with no `finishedAt` or `durationMs`,
until the domain reducer closes it at a session or turn boundary (a turn end or failure, a prompt
submission, a session end, or the agent finishing). The feed then sends one more frame for the call
with `phase: "unfinished"`, `finishedAt` set to the boundary's time, no `durationMs` and no
`evidence.output`: it reports that no result was recorded, not an outcome. The frame `id` is the
boundary event's sequence. A `PostToolUse` that arrives later replaces `unfinished`, as in the
reducer. Known limitation (#285): the reducer keeps at most 32 open calls per agent and, at a
boundary, records only the latest-started open call as `unfinished`; a call it dropped for either
reason never gets an `unfinished` frame and stays `running` in the feed.

```text
{ "toolCallId", "agentId", "toolName"?, "phase": "running" | "succeeded" | "failed" | "unfinished",
  "startedAt"?, "finishedAt"?, "durationMs"?, "summary"?, "filePaths": string[],
  "evidence": { "input": EvidenceRef | null, "output": EvidenceRef | null } }
EvidenceRef = { "id", "status": "stored" | "evicted" }
```

`toolName` is absent only for a finish whose start was never recorded. `evidence.input` is set when
a body was stored for the call, `evidence.output` only once the call finished (never for `running` or `unfinished`); `status` is the
evidence store's state when the frame is written, so an evicted body still shows that the call
happened (`GET /v1/evidence/:id` then answers `410`). The heartbeat after the backlog
(carrying the head) marks the client as caught up; the engine sends it after the backlog frames and
a turn of the event loop, and not at all if the stream already ended. The catch-up heartbeat's `head` is the last
project event folded, so it may count frames still queued for the client and not yet written. An
idle heartbeat carries the storage head; when that is ahead of what the stream folded, the stream
goes back to the backlog and sends the missing frames before the next heartbeat.
The stream cap is checked before the agent is looked up: with the cap full, an unknown agent or
project is `503 too_many_streams`, not `404`.

#### `GET /v1/agents/:id/crew?projectId=P`

`200 { "agentId", "projectId", "team"?, "subagents": CrewMember[], "teammates": CrewMember[] }`.
`subagents` are the agent's direct children and each carries its own `children`, recursively.
`teammates` are the members of the team the agent leads, in order of first registration (empty for
anyone else); `team` is `{ "id", "name"?, "leadAgentId", "startedAt", "endedAt"? }` for a lead or a
member. A lead that ran several teams gets the one still running, else the latest started. A member is
`{ "agentId", "kind": "subagent" | "teammate", "displayName"?, "agentType"?, "parentAgentId"?,
"status": "running" | "finished", "currentActivity"?: { "activity", "since", "heuristic" },
"startedAt", "finishedAt"?, "elapsedMs", "resultSummary"?, "heuristic", "children" }`.

Links come only from recorded registrations (constitution IV): a subagent is a child after a
registration named its parent, a teammate a member after a registration named its team. A heuristic
guess is never a link, so `heuristic` is `false` for every member listed; `currentActivity.heuristic`
carries the activity's own flag, and `currentActivity` is present only while the member runs.
`status` is `running` until the agent finished or, for a teammate, its team ended. `elapsedMs` is
`finishedAt` (or the engine clock while running) minus `startedAt`, from recorded times only.
`resultSummary` is the summary of the agent's `agent.finished` event, when it had one. Finished
agents beyond the reducer's retention are not listed.

#### `GET /v1/evidence/:id`

`200 { "id", "projectId", "toolCallId", "part": "input" | "output", "text", "masks":
[{ "start", "end", "kind" }], "truncated", "bytes" }`. `text` is the stored, already redacted body as
plain text, never HTML and never HTML-escaped (the client escapes at render time, ARCHITECTURE.md
12). `masks` locate each `[REDACTED:kind]` marker in `text` by UTF-16 offsets, `[start, end)`,
sorted; a body the redactor did not change has none. `masks` is a rendering hint, not proof of
redaction: text the tool itself printed can contain a literal `[REDACTED:kind]` that looks like a
mask, so a client treats the marker text and the spans as display help only. An evidence ID carries its project, so it
resolves in one project only. `404 unknown_evidence` for an ID that was never handed out or whose
body was never stored; `410 evidence_evicted` ("details no longer stored") when the cap evicted it.

### `POST /v1/commands`, `GET /v1/commands/:id` (M4.03)

Registered with the full security middleware. A request with any token gets `403
credential_not_allowed`; a paired browser session needs a matching `Origin`. Until the command
service registers its routes (`registerCommandRoutes`) the paths answer `501 not_implemented` with
no side effects. `taskville serve` registers them (M4.04) through `wirePermissionBridge`, which
also wires the bridge and the input route below.

Request bodies are strict: an unknown key at any level is `400 bad_request`, and a body over 16 KiB
is `413 payload_too_large`. Every body carries `projectId`, `requestId`, and `idempotencyKey`, and
an optional `context: { "mode": "live" | "history" }`. A `history` context is
`400 history_context_rejected`, checked before anything else happens (a repeated key cannot bypass
it).

- `{ "type": "permission.decide", ..., "decision": { "behavior": "allow" } | { "behavior": "deny",
  "message"? } }`. `message` is passed to the agent and is not recorded in the log; the audit
  payload keeps the behavior and, for a note, only a SHA-256 digest of it. A blank `message`
  (empty, whitespace, or control characters only) counts as absent and the agent gets the default
  note "Denied in Taskville". C0 and C1 control characters and DEL are stripped from a note
  before it reaches the agent, except newline and tab. The bridge must hold the request under the
  command's project and the recorded request's session, or the command is `request_expired` and
  the decision is never sent.
- `{ "type": "session.open", ..., "sessionId" }`. `requestId` must be an open request of the same
  project and session (answerable or not). The working directory is read from the recorded
  session (`session.started` `workingDirectory`), never from the body, and the opener template
  comes only from the engine config. When the template uses `{cwd}`, the directory is resolved
  with `realpath` and must lie inside one of the project's configured roots (the root itself is
  allowed; roots are resolved too); a resolved name ending in `.app`, `.command`, `.workflow`,
  `.terminal`, or `.tool` is refused. The opener gets the resolved path. A body with `cwd`,
  `template`, or `sessionOpener` is `400 bad_request`.

Success is `200 { "command": { "id", "type", "requestId", "status", "result"? } }`.
`permission.decide` ends `delivered` ("sent, unconfirmed", decision #116 D4): the engine records
`command.requested`, `request.resolved` (`answered_here`, with `decision`), and `command.delivered`,
and never `command.succeeded`: a decision is "sent, unconfirmed" and no later telemetry, M4.04's wiring included, upgrades it (decision #116 D4). `session.open` ends
`succeeded` with `result: { "outcome": "opened" | "copy-only", "sessionId", "cwd"? }` (events:
`command.requested`, `command.delivered`, `command.succeeded`). The `result` is held in memory
only (the newest 500 by default; `maxRememberedResults`), so after a restart or once forgotten a
replay or `GET` returns `succeeded` without `result`.

If recording `request.resolved` or `command.delivered` fails after the decision reached the hook
response, the response is still `200 delivered`, the error name is logged, and a retry with the same
key returns that command. When the command service starts, a `permission.decide` left `requested`
and a `session.open` left `requested` or `delivered` by an engine stop are ended as `failed`; a
`delivered` `permission.decide` is left as it is.

Errors are `{ "error": { "code", "message" }, "command"?: { "id", "type", "requestId", "status" } }`.
A `command` is present when the command was recorded.

| Status | Code | When | Recorded |
| --- | --- | --- | --- |
| 400 | `bad_request` | invalid body or JSON | nothing |
| 400 | `history_context_rejected` | `context.mode` is `history` | nothing |
| 404 | `unknown_project`, `unknown_request`, `unknown_session` | the target does not exist | nothing |
| 409 | `request_not_open` | the recorded request is already closed (checked without asking the bridge); also for `session.open` | requested, failed |
| 409 | `request_session_mismatch` | `session.open` names a request that belongs to another session | requested, failed |
| 422 | `not_answerable` | the request was not bridge-held | requested, unsupported |
| 410 | `request_expired` | the bridge no longer holds the request, or the decision reached no open hook response | requested, expired |
| 409 | `idempotency_conflict` | the key was used for a different command | nothing |
| 409 | `command_in_flight` | an opener is already running for the session (any key) | nothing |
| 502 | `opener_failed` | the opener could not be started, or its directory is not a directory or is outside the project's roots; the message is non-secret and never carries the path | requested, failed |

The same `idempotencyKey` with the same command returns the same command and status and does not
ask the bridge or run the opener again, also after its request has closed. A `GET /v1/commands/:id` for a paired session returns
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

### `GET /v1/requests/:requestId/input?projectId=<id>` (M4.04)

The exact, unmasked tool input of a request whose hook response the bridge still holds, for the
decision card. A paired browser session only (`command` scope): the CLI, shim, and bridge tokens
get `403 credential_not_allowed`. The response carries `Cache-Control: no-store` and, like every
route, no CORS header. The input is never logged and never appears in an error.

`200 { "requestId", "projectId", "sessionId", "toolName", "toolInput"?, "cwd"? }`. `toolInput` is
the hook's `tool_input` as sent, so it is absent when the hook sent none; `cwd` is the hook's
working directory, when it sent one. Errors:

| Status | Code | When |
| --- | --- | --- |
| 400 | `bad_request` | no `projectId` query parameter |
| 404 | `unknown_request` | no such request, or the request belongs to another project |
| 410 | `request_expired` | the request is recorded but no longer held: decided, hold window over, closed by a matching `PostToolUse`, or never held |

### Hold window and the installed hook (M4.04)

`bridge.holdWindowSeconds` in `config.json` is a whole number of seconds from 1 to 300 (default
90); anything else is refused by `taskville serve` and `taskville install claude-code` with
`bridge.holdWindowSeconds: must be a whole number of seconds from 1 to 300`. The hook's own
timeout is the hold window plus 5 seconds, so the engine always answers first.

`taskville install claude-code` now loads `config.json` on every run, also when `--url` or
`$TASKVILLE_URL` gives the engine URL (the timeout and the range check need it). An unreadable or
invalid config file, or a `--url` / `$TASKVILLE_URL` that is not `http://127.0.0.1:<port>` or
`http://localhost:<port>`, fails the install with exit code 1 and writes nothing.

`taskville install claude-code` writes, besides the 15 telemetry command hooks,
`hooks.PermissionRequest = [{ "hooks": [{ "type": "http", "url":
"<engine url>/v1/bridge/claude-code/permission", "timeout": <holdWindowSeconds + 5>, "headers": {
"Authorization": "Bearer $TASKVILLE_BRIDGE_TOKEN" }, "allowedEnvVars": ["TASKVILLE_BRIDGE_TOKEN"]
}] }]` with no matcher. The port follows the telemetry hooks (`--url`, `$TASKVILLE_URL`, the
config port), but the hook URL always uses the loopback IP `127.0.0.1`, never `localhost`, which
can resolve to `::1` (decision #284 default); the timeout is read from `config.json` even when
`--url` is given. The install output suggests setting `TASKVILLE_BRIDGE_TOKEN` for the Claude Code
launch only (`env TASKVILLE_BRIDGE_TOKEN="$(cat <home>/bridge-token)" claude`) and names the token
file; the token is never written to the settings file or printed. Uninstall removes only an `http` hook whose URL is exactly
a loopback origin plus the bridge route.

### `GET /health`

`200 { "status": "ok", "db": "ok", "walMode": true, "uptimeSeconds", "version" }`;
`503` with `db: "error"` when the database cannot be read.

## Later routes (ARCHITECTURE.md section 10, not in this feature)

`POST /v1/sources/claude-code/hooks` (M2), `GET /v1/agents/:id/feed` and
`GET /v1/agents/:id/crew` (M5), `GET /v1/evidence/:id` (M2.06),
imports (M8), OTLP (M5.12). Each inherits the security checks above.
