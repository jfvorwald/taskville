# Implementation Plan: Headless Foundation

**Branch**: `001-headless-foundation` | **Date**: 2026-10-30 | **Spec**: [spec.md](spec.md)

**Input**: Feature specification from `specs/001-headless-foundation/spec.md`

## Summary

Build the browser-free core of Taskville: a versioned event protocol, a pure
deterministic reducer, an append-only SQLite event log with atomic projections,
an HTTP API with resumable SSE, a CLI, and a seeded six-agent demo. This is
ARCHITECTURE.md section 14, milestone M1. Everything later (city, overlays, history,
adapters) consumes the snapshot-plus-stream contract defined here.

Technical approach (see [research.md](research.md)): TypeScript 7 on Node 26, Hono 4
on `@hono/node-server` for HTTP and SSE, built-in `node:sqlite` for storage, Zod
schemas in a shared protocol package, one single-writer engine process, projections
stored as a JSON document per project in the same transaction as the event insert.

## Technical Context

**Language/Version**: TypeScript 7 (native `tsc` for typechecking, erasable syntax only), Node.js 26 (local: v26.8.2)

**Primary Dependencies**: Hono 4 with `@hono/node-server` (routing, security middleware, Zod request validation, `streamSSE`); Zod 4 (schemas and validation); pino (structured logs); Node built-ins `node:sqlite`, `node:util.parseArgs`, `node:crypto`.

**Storage**: SQLite via `node:sqlite` `Database` and `Statement` (the `*Sync` names are deprecated aliases), WAL mode, explicit `BEGIN IMMEDIATE`/`COMMIT`, one database file per Taskville home (`$TASKVILLE_HOME/taskville.db`, default `~/.taskville`). Evidence bodies go to a separate `evidence.db` from M2.06.

**Testing**: Vitest 5 (unit and integration), fast-check (reducer properties), committed JSONL fixtures, `tsc --noEmit`, Biome 2 lint

**Target Platform**: macOS and Linux developer machines, loopback only

**Project Type**: pnpm workspace: headless service + CLI + shared libraries

**Performance Goals**: 1,000-event batch acked < 1 s; ingest-to-viewer < 250 ms local (SC-004, SC-005)

**Constraints**: engine imports no UI code; gap-free ingest sequence; commit before ack/broadcast; engine resident memory grows less than 10% between hour 1 and hour 8 of the six-agent demo (SC-006)

**Scale/Scope**: single user, a handful of projects, 6 demo agents; up to ~10^6 events per project before any pruning question arises

No NEEDS CLARIFICATION items remain. The owner clarified the spec on 2026-10-30 (spec.md Clarifications); M1.01 aligned these documents with ARCHITECTURE.md revision 3.

## Constitution Check

*GATE: Must pass before Phase 0 research. Re-check after Phase 1 design.*

Constitution: `.specify/memory/constitution.md` v1.2.0 (ratified 2026-10-30, last amended 2026-10-30).

| Principle | Gate | Pre-research | Post-design |
| --- | --- | --- | --- |
| I. Headless Engine First | Engine and CLI have no React/Three/DOM deps; every capability reachable from CLI, except answering permission prompts (owner-approved exception) | PASS | PASS - `apps/engine` depends only on `protocol`, `domain`, `adapters` (redaction); CLI covers every route in [contracts/cli.md](contracts/cli.md); `taskville requests` lists pending requests read-only and nothing in the CLI answers them (FR-018) |
| II. Event Log Is the Truth | Append-only events; idempotent key; commit-then-ack; rebuildable projections | PASS | PASS - `events` table has no UPDATE path; `projections.reducer_version` triggers rebuild ([data-model.md](data-model.md)) |
| III. Pure, Deterministic Domain | Reducer pure; same events give same hash | PASS | PASS - `domain` has no I/O imports; `stateHash` over canonical JSON |
| IV. Observe, Don't Invent | Unknown states stay `unknown`; no name merges; disconnect does not fail tasks | PASS | PASS - `unknown` is a member of every status enum; identity keyed on `(sourceId, sourceAgentId)` |
| V. Side Effects via Command Service | No side-effect routes in this feature | PASS (N/A) | PASS - `POST /v1/commands` is a credential-checked stub returning `501`; no route dispatches to runtimes; `command.*` events are engine-only |
| VI. Test-First at Boundaries | Required tests listed before implementation | PASS | PASS - see Test Plan |
| VII. Calm and Simple | New packages justified | PASS with justification | PASS - see Complexity Tracking |
| Security constraints | Loopback; Host check and a credential on every route, reads included; browser pairing via `X-Taskville-Session`; no cookies; Origin check; tokens never authorize commands | PASS | PASS - [contracts/http-api.md](contracts/http-api.md) section Security |

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
└── tasks.md             # Task list mirroring the M1 GitHub issues
```

### Source Code (git repository root)

Paths are relative to the Git repository root (`dev/taskville/`), matching
ARCHITECTURE.md section 5. Spec-kit now lives at the same root (research.md R-10).

```text
package.json, pnpm-workspace.yaml, tsconfig.base.json, biome.json, vitest.config.ts
packages/
  protocol/        # Zod schemas: envelope, event types v1, API request/response, SSE frames
    src/  test/
  domain/          # Pure reducer, selectors, canonical JSON + stateHash, attention rules
    src/  test/
  adapters/        # In M1 only src/redact/: secret masking for FR-017 (M1.20)
    src/  test/
  demo/            # Seeded PRNG, virtual clock, six-agent scenario producer
    src/  test/
apps/
  engine/          # Hono server, auth and pairing, SSE hub, ingestion pipeline, SQLite storage + migrations
    src/storage/  src/http/  src/auth/  src/config/  src/ingest/  src/stream/
    test/
  cli/             # `taskville` binary: serve, project add|list, status, events ingest|follow, requests, unpair, demo start|run
    src/  test/
fixtures/
  events/          # basic-two-agents.jsonl, duplicates.jsonl, conflicts.jsonl, invalid.jsonl
.claude/check.sh   # fast gate: typecheck, lint, unit + integration tests (if the hierarchy is used)
```

**Structure Decision**: pnpm workspace per ARCHITECTURE.md section 5, limited to the
six units this feature needs. Storage lives inside `apps/engine/src/storage` until a
second consumer needs it. `packages/adapters` holds only the redaction module in M1;
the Claude Code mappers arrive in M2, and `apps/web` in M3.

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
| bad Host rejected on GET and POST; missing or wrong credential rejected on reads and writes; bad Origin rejected; no `Set-Cookie` | integration, engine | FR-014 |
| pairing code single-use; session header accepted on reads; CLI token refused on the `POST /v1/commands` stub | integration, engine | FR-014 |
| unknown project rejected with `unknown_project`, nothing created; `project add` then ingest accepted | integration, engine | FR-011 |
| engine-only types and `taskville:` sources rejected from the batch route | integration, engine | FR-019 |
| reason with a fake token stored masked and truncated with flags | integration, engine | FR-017 |
| attention levels; one prompt one red state; telemetry request never answerable; late request never opens `needs_you`; heuristic `silent` via injected clock | unit, domain | FR-019 |
| subagent and teammate parentage | unit, domain | FR-005 |
| demo same seed and pace same hash; different seed differs | unit, demo | FR-013, US3 |
| CLI ingest + status against fixture golden output; indented tree with and without `--all` | integration, cli | US1, FR-012, SC-001 |
| `requests` lists open requests read-only | integration, cli | FR-018 |
| 1,000-event batch timing (reported, not a CI gate) | bench script | SC-004 |
| ingest-to-viewer latency and 8-hour memory growth (M1.21) | perf script | SC-005, SC-006 |

## Phase 2 preview (for /speckit-tasks)

Order: workspace scaffold -> protocol -> domain (with tests) -> engine storage ->
auth -> ingestion -> snapshot -> SSE -> CLI -> demo -> quickstart walkthrough.
US2 is shippable after SSE and US3 after the demo. US1 is not shippable on its own:
its CLI ticket (T015, M1.14) also delivers US2's `events follow`, so it waits on the
SSE ticket (T016). This was accepted in the analysis (finding F1) and is recorded in
[tasks.md](tasks.md).

## Open questions for the owner

None. Earlier questions are answered: the first runtime adapter is Claude Code
(ARCHITECTURE.md section 8.1, milestone M2), and agent-supplied attention reasons
are stored masked and truncated to 280 characters (spec.md Clarifications, FR-017).
Where projects are declared is recorded as a default in research.md R-12.

## Complexity Tracking

| Violation | Why Needed | Simpler Alternative Rejected Because |
|-----------|------------|-------------------------------------|
| 6 workspace units instead of 1 | `protocol`, `domain`, and `adapters` must be imported by the future browser client without pulling in Node built-ins; `demo` must run both in-engine and as an external producer | A single package would force the web bundle to tree-shake Node built-ins and would blur Principle I |
| Zod dependency | One schema source for runtime validation, TS types, and JSON Schema export for adapter authors | Hand-written validators drift from types; TypeBox/Valibot are viable but offer no clear gain here |
| Hono 4 and `@hono/node-server` | One tested middleware layer for the Host, credential, and Origin checks on every route; Zod request validation; `streamSSE` handles client aborts (ARCHITECTURE.md section 5.1) | Hand-written `node:http` router: fewer dependencies, but the security checks and validation would be hand-rolled. Fastify: heavier plugin model |
| pino | Structured engine logs for debugging and retros (ARCHITECTURE.md section 5.1) | `console` output: unstructured and hard to filter |
| fast-check (dev) | Property tests for reducer determinism (constitution VI) | Hand-picked sequences miss orderings |
