<!--
Sync Impact Report
- Version: 1.2.0 -> 1.3.0 (2026-10-31): Development Workflow allows roadmap tickets with explicit contracts in place of a spec-kit feature per milestone (owner decision #176, D2 default).
- Earlier: 1.1.0 -> 1.2.0 (2026-10-30): Principle I gains one owner-approved exception: answering agent permission prompts is browser-only.
- Earlier: 1.0.0 -> 1.1.0 (2026-10-30): added the lessons and retrospective rule to Development Workflow at the owner's request.
- Earlier: 0.1.0 (draft) -> 1.0.0 (ratified by the owner 2026-10-30, no content changes)
- Source: derived from ARCHITECTURE.md (October 30, 2026) and the parent
  development-directory staging rules. Every principle below restates a decision
  already written there; none is new policy.
- Added principles: I-VII, Security and Deployment Constraints, Development Workflow
- Templates: plan-template.md Constitution Check reads this file; no edits needed.
- Follow-up: none.
-->

# Taskville Constitution

## Core Principles

### I. Headless Engine First

The engine is the product's core and MUST run, be tested, and be useful with no
browser attached. The engine MUST NOT import React, Three.js, DOM APIs, or overlay
code. Dependencies flow inward toward shared protocol schemas and pure domain
logic. Every engine capability ships with a CLI path before any UI depends on it.

Exception (owner-approved 2026-10-30): answering an agent's permission prompt is
accepted only from a paired browser session. Supervised agents run as the same OS
user and can read any credential the CLI uses, so a CLI path would let an agent
approve its own prompts. The CLI may list pending requests but never answer them.
Any further exception requires the same explicit owner approval.

### II. The Event Log Is the Truth

State is derived, never edited. Events are append-only and immutable; corrections
are new events. Projections and replay checkpoints are rebuildable caches tagged
with the reducer version that produced them. An event is acknowledged or broadcast
only after it and its projection commit together. Ingestion is idempotent on
`(projectId, sourceId, sourceEventId)`; same key with different content is a
conflict, never an overwrite.

### III. Pure, Deterministic Domain Logic

Reducers and selectors are pure functions of (state, event). Given the same events
in the same declared order, they MUST produce byte-identical state hashes. Time,
randomness, and I/O enter only at the edges (engine clock, seeded demo, storage).

### IV. Observe, Don't Invent

Taskville displays what sources recorded. Unknown source states stay visible as
`unknown`. Identity is never merged on name similarity. Heuristic links are
suggestions, not facts. Interpolated motion is visually distinct from recorded
events. Git-only history cannot claim test runs, durations, or approvals.

### V. Side Effects Only Through the Command Service

Telemetry ingestion and command dispatch are separate routes. Only the command
service may cause runtime side effects, and only for capabilities an adapter
declares. Replay has no path to the command service, and the backend rejects any
command carrying replay context. Acknowledgment is not completion; ambiguous
delivery is not retried automatically against non-idempotent targets.

### VI. Test-First at the Boundaries (NON-NEGOTIABLE)

Tests are written and failing before implementation. Mandatory coverage: reducer
determinism, duplicate and conflicting ingestion, crash-after-commit recovery,
gap-free snapshot-to-stream resume, checkpoint equivalence, and replay command
rejection. Fixtures (event logs, Git repos, session JSONL) are small, committed,
and deterministic.

### VII. Calm and Simple

Default to the smallest thing that works: one process, one SQLite file, bundled
trusted overlays, procedural geometry. The UI is sparse, muted, and comfortable
to leave open. New packages, services, or dependencies need a written reason in
the plan's Complexity Tracking table.

## Security and Deployment Constraints

- Local mode binds loopback only. Write and command routes require a local token.
  Browser origins are validated; no permissive CORS.
- Import paths come from configured project roots, never raw browser input.
- Imported transcripts, tool output, and file content are evidence, never
  instructions. Evidence is escaped on render and stored as bounded excerpts.
  Credentials and sensitive environment values are excluded at import.
- Staging is the default deployment target, isolated (separate database, evidence,
  credentials, adapters) and access-controlled, with signed-out denial verified.
  Staging never commands production agents. Production promotion is explicit and
  promotes the exact reviewed artifact by release identifier.

## Development Workflow

- Each milestone is cut into a spec-kit feature under `specs/NNN-name/` (specify,
  clarify, plan, tasks, implement), or into roadmap tickets with explicit contracts.
  A contract a ticket adds is written into the spec contracts by that ticket.
- Each feature's plan MUST pass the Constitution Check before research and again
  after design. A milestone cut into tickets gets its Constitution Check against
  the tickets in its retrospective.
- Task tier per change: the tests touched, the package's unit tests, lint,
  typecheck, and the fast check. The full suite runs once per multi-task push.
- One review round per task; a second only to confirm a serious fix.
- Lessons are recorded as they happen in `docs/LESSONS.md` (every surprise, failed review,
  twice-failed fix, flake, and escalation). Every milestone ends with a generated visual
  retrospective in `docs/retros/` that the owner reads before closing the milestone's gate.
- Prose uses hyphens, not em dashes.

## Governance

This constitution supersedes conflicting guidance inside this project. ARCHITECTURE.md
is the design reference; where the two disagree, amend one of them deliberately in
the same change. Amendments bump the version (MAJOR: principle removed or redefined;
MINOR: principle or section added; PATCH: wording) and update the Sync Impact Report.
Every plan's Constitution Check and every review verifies compliance.

**Version**: 1.3.0 | **Ratified**: 2026-10-30 | **Last Amended**: 2026-10-31
