# Implementation Plan: Headless Foundation

**Branch**: `001-headless-foundation` | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-headless-foundation/spec.md`

## Summary

Build the browser-free core of Taskville: a versioned event protocol, a pure
deterministic reducer, an append-only SQLite event log with atomic projections,
an HTTP API with resumable SSE, a CLI, and a seeded six-agent demo. This is
ARCHITECTURE.md section 14, step 1. Everything later (city, overlays, replay,
adapters) consumes the snapshot-plus-stream contract defined here.

Technical approach (see [research.md](research.md)): TypeScript on Node 26 using
built-in `node:sqlite` and `node:http`, Zod schemas in a shared protocol package,
one single-writer engine process, projections stored as a JSON document per
project in the same transaction as the event insert.

## Technical Context

**Language/Version**: TypeScript 5.x (erasable syntax only), Node.js 26 (local: v26.8.2)

**Primary Dependencies**: Zod 4 (schemas and validation); Node built-ins `node:sqlite`, `node:http`, `node:util.parseArgs`, `node:crypto`. No web framework.

**Storage**: SQLite via `node:sqlite` `DatabaseSync`, WAL mode, one database file per Taskville home (`$TASKVILLE_HOME/taskville.db`, default `~/.taskville`)

**Testing**: Vitest (unit and integration), committed JSONL fixtures, `tsc --noEmit`, Biome lint

**Target Platform**: macOS and Linux developer machines, loopback only

**Project Type**: pnpm workspace: headless service + CLI + shared libraries

**Performance Goals**: 1,000-event batch acked < 1 s; ingest-to-viewer < 250 ms local (SC-004, SC-005)

**Constraints**: engine imports no UI code; gap-free ingest sequence; commit before ack/broadcast; flat memory over an 8-hour demo

**Scale/Scope**: single user, a handful of projects, 6 demo agents; up to ~10^6 events per project before any pruning question arises

No NEEDS CLARIFICATION items remain; open product questions are listed under "Open questions for the owner" below and do not block this feature.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution: `.specify/memory/constitution.md` v1.0.0 (ratified 2026-10-30).

| Principle | Gate | Pre-research | Post-design |
| --- | --- | --- | --- |
| I. Headless Engine First | Engine and CLI have no React/Three/DOM deps; every capability reachable from CLI | PASS | PASS - `apps/engine` depends only on `protocol`, `domain`; CLI covers every route in [contracts/cli.md](contracts/cli.md) |
| II. Event Log Is the Truth | Append-only events; idempotent key; commit-then-ack; rebuildable projections | PASS | PASS - `events` table has no UPDATE path; `projections.reducer_version` triggers rebuild ([data-model.md](data-model.md)) |
| III. Pure, Deterministic Domain | Reducer pure; same events give same hash | PASS | PASS - `domain` has no I/O imports; `stateHash` over canonical JSON |
| IV. Observe, Don't Invent | Unknown states stay `unknown`; no name merges; disconnect does not fail tasks | PASS | PASS - `unknown` is a member of every status enum; identity keyed on `(sourceId, sourceAgentId)` |
| V. Side Effects via Command Service | No side-effect routes in this feature | PASS (N/A) | PASS - command service is out of scope; no route dispatches to runtimes |
| VI. Test-First at Boundaries | Required tests listed before implementation | PASS | PASS - see Test Plan |
| VII. Calm and Simple | New packages justified | PASS with justification | PASS - see Complexity Tracking |
| Security constraints | Loopback, token on writes, origin check | PASS | PASS - [contracts/http-api.md](contracts/http-api.md) section Auth |

## Project Structure

### Documentation (this feature)

```text
specs/001-headless-foundation/
├── plan.md              # This file
├── research.md          # Phase 0 decisions
├── data-model.md        # Entities, tables, state machines
├── quickstart.md        # Runnable validation guide
├── contracts/
│   ├── events.md        # Event envelope and event types v1
│   ├── http-api.md      # HTTP + SSE endpoints
│   └── cli.md           # CLI commands and exit codes
└── tasks.md             # Next: /speckit-tasks (not created here)
```

### Source Code (git repository root)

Paths are relative to the Git repository root (`dev/taskville/`), matching
ARCHITECTURE.md section 4. Spec-kit now lives at the same root (research.md R-10).

```text
package.json, pnpm-workspace.yaml, tsconfig.base.json, biome.json, vitest.workspace.ts
packages/
  protocol/        # Zod schemas: envelope, event types v1, API request/response, SSE frames
    src/  test/
  domain/          # Pure reducer, selectors, canonical JSON + stateHash, attention rules
    src/  test/
  demo/            # Seeded PRNG, virtual clock, six-agent scenario producer
    src/  test/
apps/
  engine/          # node:http server, SSE hub, ingestion pipeline, SQLite storage + migrations
    src/storage/  src/http/  src/ingest/  src/stream/
    test/
  cli/             # `taskville` binary: serve, status, events ingest|follow, demo start|stop
    src/  test/
fixtures/
  events/          # basic-two-agents.jsonl, duplicates.jsonl, conflicts.jsonl, invalid.jsonl
.claude/check.sh   # fast gate: typecheck, lint, unit + integration tests (if the hierarchy is used)
```

**Structure Decision**: pnpm workspace per ARCHITECTURE.md, limited to the five
units this feature needs. `storage` is folded into `apps/engine/src/storage`
until a second consumer (replay, feature 005) exists; `adapters`, `importers`,
`replay`, `city`, `overlays`, and `apps/web` are not created yet.

## Test Plan (written first, per Principle VI)

| Test | Level | Proves |
| --- | --- | --- |
| reducer determinism (property: same events, same hash; shuffled independent sources sorted by declared order) | unit, domain | FR-005, SC-002 |
| unknown status preserved; disconnect keeps task | unit, domain | FR-006, edge cases |
| duplicate and conflict classification | integration, engine | FR-003 |
| partial batch: valid commit, invalid rejected with reason | integration, engine | FR-001, FR-002 |
| gap-free sequence under concurrent batch requests | integration, engine | FR-004 |
| crash after commit before broadcast (kill hook between commit and publish), resume delivers | integration, engine | US2-2 |
| snapshot-to-stream resume, 100 disconnect cycles | integration, engine | FR-007, FR-008, SC-003 |
| slow consumer cut off; others unaffected | integration, engine | FR-009 |
| reducer version bump rebuilds projection | integration, engine | FR-010 |
| missing token / bad origin rejected | integration, engine | FR-014 |
| demo same seed same hash | unit, demo | FR-013, US3 |
| CLI ingest + status against fixture golden output | integration, cli | US1, SC-001 |
| 1,000-event batch timing (reported, not a CI gate) | bench script | SC-004 |

## Phase 2 preview (for /speckit-tasks)

Order: workspace scaffold -> protocol -> domain (with tests) -> engine storage ->
ingestion -> snapshot -> SSE -> auth -> CLI -> demo -> quickstart walkthrough.
US1 is shippable after CLI ingest/status; US2 after SSE; US3 after demo.

## Open questions for the owner

These do not block feature 001 but should be settled with `/speckit-clarify` or
before feature 002:

1. Which agent runtime is first for feature 006 (Claude Code hooks, Codex, other)?
2. Should events carry a free-text "reason" for `awaiting_input` that may include
   prompt text, given the evidence-redaction rules?

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 5 workspace units instead of 1 | `protocol` and `domain` must be imported by the future browser client without pulling in `node:sqlite`/`node:http`; `demo` must run both in-engine and as an external producer | A single package would force the web bundle to tree-shake Node built-ins and would blur Principle I |
| Zod dependency | One schema source for runtime validation, TS types, and JSON Schema export for adapter authors | Hand-written validators drift from types; TypeBox/Valibot are viable but offer no clear gain here |
