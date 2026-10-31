# Feature Specification: Headless Foundation

**Feature Branch**: `001-headless-foundation`

**Created**: 2026-10-30

**Status**: Draft (bootstrapped from ARCHITECTURE.md section 14, step 1; not yet clarified with the owner)

**Input**: User description: "Headless event engine foundation: protocol, reducer, SQLite event log, CLI, snapshots, SSE, deterministic demo"

## Clarifications

### Session 2026-10-30

- Q: When an agent needs you, may the event log keep a reason written by the agent itself? → A: Yes, redacted (secrets masked) and cut to 280 characters; shown in the action card and history, never in quip bubbles.
- Q: Should events for a never-seen project create it automatically? → A: No. Projects are added explicitly (`taskville project add` with a name and repository folders); events for unknown project IDs are rejected with `unknown_project`; one built-in Unsorted project always exists for sources whose folder matches no project.
- Q: What counts as "flat memory" for the 8-hour demo? → A: Engine resident memory grows less than 10% between hour 1 and hour 8 (at 1x, or the same event count accelerated).
- Q: How does `taskville status` show subagents and teammates? → A: An indented tree: each top-level agent with its subagents and teammates beneath it; finished subagents hidden unless `--all`.
- Q: How busy should the demo feel at 1x? → A: Configurable pace. Default "calm": a visible change every 5 to 15 seconds and a needs-you moment about every 3 minutes; a "lively" preset (every 1 to 3 seconds) and custom intervals are available through a `--pace` option.

## User Scenarios & Testing *(mandatory)*

### User Story 1 - Ingest agent events and see who is doing what (Priority: P1)

An agent (or a script standing in for one) sends activity events to a locally
running Taskville engine. The user asks the CLI for a project's status and sees,
for each agent, its connection state, current task, current activity, and whether
it needs input. No browser is involved.

**Why this priority**: This is the smallest slice that answers the product's core
question ("who is working, who is waiting, who needs me") and every later feature
(city, overlays, replay, adapters) reads from it.

**Independent Test**: Start the engine headless, ingest a committed JSONL fixture
with the CLI, run `status`, and compare the output to an expected snapshot.

**Acceptance Scenarios**:

1. **Given** an empty project, **When** a batch registering two agents and assigning
   one a task is ingested, **Then** status lists both agents, one with the task and
   `running`, the other idle and connected.
2. **Given** a batch was ingested, **When** the identical batch is ingested again,
   **Then** every event is reported as a duplicate and the state is unchanged.
3. **Given** an ingested event, **When** an event with the same source key but
   different content arrives, **Then** it is reported as a conflict and not applied.
4. **Given** a session with two running subagents and one finished subagent, **When**
   status is requested, **Then** the two running subagents appear indented under their
   parent and the finished one appears only with `--all`.
5. **Given** an agent marked `awaiting_input`, **When** status is requested,
   **Then** that agent is flagged as needing attention with the recorded reason.
6. **Given** an event with an unsupported schema version or invalid shape, **When**
   it is ingested, **Then** it is rejected with an actionable per-event error and
   the rest of the batch is still processed.

---

### User Story 2 - Follow a project live and resume without gaps (Priority: P2)

A viewer (the future web client, or the CLI in watch mode) takes a snapshot of a
project, then follows its live event stream. If the connection drops, it resumes
from where it left off without missing or duplicating events.

**Why this priority**: The city and overlays need exactly this contract. Proving
it headless keeps the browser work purely presentational.

**Independent Test**: Snapshot at cursor N, ingest more events, disconnect,
ingest more, reconnect with cursor N, and verify the received sequence is exactly
N+1..latest with no gaps or repeats.

**Acceptance Scenarios**:

1. **Given** a snapshot returned cursor N, **When** the viewer subscribes after N,
   **Then** it receives the durable backlog after N, then live events, in ingest order.
2. **Given** the engine crashes after committing an event but before broadcasting,
   **When** it restarts and a viewer resumes, **Then** the viewer receives that event.
3. **Given** a cursor that is invalid or no longer servable, **When** the viewer
   subscribes, **Then** it receives an instruction to resnapshot.
4. **Given** a consumer that stops reading, **When** its buffer limit is reached,
   **Then** it is disconnected with a recovery instruction and other viewers are unaffected.

---

### User Story 3 - Run a deterministic six-agent demo (Priority: P3)

A developer starts a seeded demo that produces a stream of six agents being
assigned work, handing off tasks, waiting for input, and completing, at a
configurable pace whose default (`calm`) suits an ambient display.

**Why this priority**: It is the data source for building and reviewing the city
(feature 002) before any real runtime is integrated, and it doubles as a soak test.

**Independent Test**: Run the demo twice with the same seed in accelerated time and
compare final state hashes; they must match.

**Acceptance Scenarios**:

1. **Given** seed 42, **When** the demo runs for a fixed simulated duration twice,
   **Then** both runs produce the same event sequence and final state hash.
2. **Given** a running demo, **When** status is requested, **Then** at least one
   agent is working and, within a bounded simulated time, one is awaiting input and
   one handoff has occurred.
3. **Given** demo events, **When** they are stored, **Then** they carry `demo`
   provenance and can never be mistaken for live or imported events.

---

### Edge Cases

- An agent disconnects mid-task: connection becomes `disconnected`; its task and
  last activity are kept, not set to failed or idle.
- A source emits a status Taskville does not know: stored and shown as `unknown`.
- One agent runs several sessions at once: one primary activity plus a session count.
- Events arrive out of occurrence-time order from the same source: ingest order is
  kept for transport; historical order uses source sequence then event ID.
- Batch partly valid: per-event results; valid events commit, invalid ones do not.
- Engine restarted with an older reducer version's projection on disk: projection
  is rebuilt from the event log before serving.
- Event for a project that was never added: rejected with `unknown_project`; nothing is created.
- Write request without the local token, or from a disallowed browser origin: rejected.

## Requirements *(mandatory)*

### Functional Requirements

- **FR-001**: System MUST accept event batches with per-event results (accepted,
  duplicate, conflict, rejected) and a reason for non-accepted events.
- **FR-002**: System MUST validate every event against a versioned schema at ingestion
  and reject unsupported versions with an actionable error.
- **FR-003**: System MUST deduplicate on (project, source, source event ID) and treat
  same-key different-content as a conflict.
- **FR-004**: System MUST assign a gap-free, monotonically increasing ingest sequence
  per project and commit event plus projection atomically before acknowledging.
- **FR-005**: System MUST derive agent, session, task, and activity state with a pure,
  deterministic reducer and expose a state hash.
- **FR-006**: System MUST keep connection state separate from activity state.
- **FR-007**: System MUST provide a project snapshot that includes an atomic resume cursor.
- **FR-008**: System MUST stream events after a cursor, serving durable backlog before
  live events, and signal resnapshot when a cursor is unservable.
- **FR-009**: System MUST bound per-subscriber buffers and disconnect slow consumers
  with a recovery instruction.
- **FR-010**: System MUST rebuild projections from the event log when the reducer
  version changes.
- **FR-011**: System MUST support multiple projects, each with isolated state. Projects are created only explicitly (CLI `project add`); a built-in Unsorted project always exists; events naming an unknown project are rejected with `unknown_project`.
- **FR-012**: CLI MUST provide: start the engine headless, add and list projects, show project status, ingest
  a JSONL file, follow events, and start/stop a seeded demo.
- **FR-013**: System MUST provide a seeded demo producer whose output is reproducible for a given seed and pace. Pace is configurable (`calm` default: a visible change every 5 to 15 s and a needs-you moment about every 3 min at 1x; `lively`: every 1 to 3 s; or custom intervals).
- **FR-014**: System MUST bind to loopback by default, require a local token for
  write routes, and reject disallowed browser origins.
- **FR-015**: System MUST expose a health endpoint reporting process and storage health.
- **FR-016**: System MUST store each event's provenance (`live`, `imported`, `demo`).
- **FR-017**: System MUST store an agent-supplied attention reason only after secret masking and truncation to 280 characters, marking the text as truncated or masked when that happened.

### Out of Scope for This Feature

3D city, overlays, Git and session importers, replay and checkpoints, the command
service, named runtime adapters, staging deployment. Each is a later feature.

### Key Entities

- **Project**: an isolated city; name and (later) repository roots.
- **Agent**: stable identity from a source, display name, role, connection state.
- **Session**: one agent run from one source; start/end; belongs to an agent.
- **Task**: a unit of work; title, lifecycle status, assigned agents, related tasks.
- **AgentActivity**: what an agent is doing now, on which task, with latest evidence.
- **Event**: immutable envelope with source identity, timestamps, ingest sequence,
  type, payload, provenance.

## Success Criteria *(mandatory)*

### Measurable Outcomes

- **SC-001**: From a clean checkout, a developer can start the engine, ingest a sample
  file, and read status in under 5 minutes using only the quickstart.
- **SC-002**: Replaying the same event log from scratch yields an identical state hash
  in 100% of runs.
- **SC-003**: Across 100 scripted disconnect/reconnect cycles, viewers miss zero events
  and receive zero duplicates.
- **SC-004**: A batch of 1,000 events is ingested and acknowledged in under 1 second
  on the developer's machine.
- **SC-005**: A newly ingested event reaches a connected viewer in under 250 ms locally.
- **SC-006**: Over an 8-hour six-agent demo (1x speed, or the same event count accelerated), engine resident memory grows less than 10% between hour 1 and hour 8.

## Assumptions

- Single user on one machine; remote access and multi-user permissions come later.
- Event sources are trusted to send well-formed identities; ambiguous identity is
  surfaced, not resolved, in this feature.
- The work-area vocabulary (Dispatch, Test Lab, Workshop, Review, Security, Archives)
  is a presentation concern and lives in the city feature, not here.
- The proposed stack in ARCHITECTURE.md section 4 (TypeScript, pnpm workspace, Node,
  SQLite, SSE) is adopted unless the plan's research finds a reason not to.
