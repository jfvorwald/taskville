# Research: Headless Foundation

Phase 0 decisions for [plan.md](plan.md). Library versions are to be pinned and
re-validated when the workspace is scaffolded; nothing here was installed yet.

## R-1 Runtime and language

- **Decision**: TypeScript on Node.js 26. Run sources directly via Node's built-in
  type stripping in development; typecheck with `tsc --noEmit`; restrict to
  erasable syntax (`erasableSyntaxOnly`: no enums, namespaces, parameter properties).
- **Rationale**: Node 26.8.2 is installed and reports `process.features.typescript === "strip"`,
  so no build step or loader is needed for the engine and CLI.
- **Alternatives**: tsx/ts-node (extra dependency, no longer needed); Bun or Deno
  (would diverge from the ARCHITECTURE.md stack and from the later Vite web client).

## R-2 SQLite driver

- **Decision**: built-in `node:sqlite` (`DatabaseSync`), WAL mode, `synchronous=NORMAL`,
  `foreign_keys=ON`, one writer connection owned by the engine.
- **Rationale**: Verified present locally (`DatabaseSync`, `StatementSync`, `backup`).
  No native addon to compile, synchronous API suits a single-writer transactional ingest.
- **Alternatives**: better-sqlite3 (mature, but a native build per Node major);
  libsql/Turso (remote features not needed). Fallback if `node:sqlite` shows a gap:
  better-sqlite3 has a near-identical synchronous API, so the swap is contained to
  `apps/engine/src/storage`.

## R-3 HTTP server and SSE

- **Decision**: `node:http` with a small hand-written router (about ten routes in
  total across all features). SSE frames carry `id: <ingestSequence>` so
  `Last-Event-ID` and `?after=` are interchangeable.
- **Rationale**: Few routes, no middleware ecosystem needed, full control over
  backpressure (`res.write()` return value) for the bounded-buffer rule.
- **Alternatives**: Fastify (good, but adds plugin surface for little gain);
  Hono (pleasant, but its SSE helper hides backpressure); WebSockets (bidirectional
  is not needed; SSE resumes natively and is trivially consumed by `curl` and the CLI).

## R-4 Validation and schema source

- **Decision**: Zod 4 schemas in `packages/protocol`, discriminated union on `type`,
  `schemaVersion: z.literal(1)`. Export JSON Schema for adapter authors.
- **Alternatives**: TypeBox (JSON Schema native, weaker ergonomics); Valibot (smaller
  bundle, which matters less than ecosystem here).

## R-5 Atomic ingest and projection storage

- **Decision**: per batch, one `BEGIN IMMEDIATE` transaction: for each event, look up
  the idempotency key; on new, assign `ingest_sequence = project.head + 1`, insert,
  apply the reducer to the in-memory projection; then write the projection JSON and
  new head; `COMMIT`; only then publish to the SSE hub. Invalid events never touch the
  database.
- **Rationale**: Single-writer plus `BEGIN IMMEDIATE` gives a gap-free sequence without
  `AUTOINCREMENT` gaps on rollback. A JSON projection document is small at this scale
  (tens of agents and tasks) and avoids a relational projection schema that would need
  migrating every time the reducer changes.
- **Alternatives**: normalized projection tables (premature, migration-heavy);
  event-only with in-memory projection rebuilt on boot (violates "snapshot plus atomic
  cursor" across restarts and slows startup as logs grow).

## R-6 Content equality for duplicate vs conflict

- **Decision**: store `content_hash = sha256(canonicalJson(clientSuppliedFields))`
  excluding engine-assigned fields (`eventId`, `receivedAt`, `ingestSequence`).
  Same key + same hash = duplicate (return original ack); same key + different
  hash = conflict.
- **Canonical JSON**: sorted keys, no insignificant whitespace, UTF-8, numbers as
  JSON serializes them. The same function produces `stateHash` (R-7).

## R-7 Determinism and state hash

- **Decision**: reducer reads time only from the event (`occurredAt`), never `Date.now()`.
  Collections in state are maps keyed by ID and serialized in sorted key order.
  `stateHash = sha256(canonicalJson(state))`, prefixed with `reducerVersion`.
- **Test**: fast-check property tests generate event sequences and assert hash
  equality across fresh replays.

## R-8 Demo producer

- **Decision**: mulberry32 PRNG from `--seed`, a virtual clock that can run at
  1x (ambient) or accelerated (tests), and a scripted scenario of six agents
  (names as in the mockup: Ada, Pip, Rook, Moss, plus two) cycling assign, work,
  test, handoff, await input, complete. Demo is a producer that posts to the same
  ingest route with `provenance: "demo"` and `sourceId: "demo:<seed>"`.
- **Rationale**: Exercising the real ingest path makes the demo a continuous integration test.

## R-9 Local auth

- **Decision**: on first `serve`, generate a 256-bit token in
  `$TASKVILLE_HOME/token` (mode 0600). Write routes require
  `Authorization: Bearer <token>`. Read routes on loopback are open to local
  processes but browser requests must carry an allowed `Origin`
  (default: none in this feature; the web client's origin is added in feature 002).
  Server binds `127.0.0.1` only; `--host` other than loopback is refused in this feature.
- **Alternatives**: Unix socket (great for CLI, awkward for browsers and SSE in later features).

## R-10 Spec-kit location

- **Resolved 2026-10-30**: `.specify/`, `.claude/skills/speckit-*`, and `specs/` were
  moved to the Git repository root, so spec paths and code paths share one root.

## R-11 Tooling

- **Decision**: pnpm workspace (pnpm present locally), Vitest, Biome for lint and
  format, fast-check for property tests. One `pnpm check` script = typecheck + lint +
  tests; it backs `.claude/check.sh` if the delegation hierarchy is used.
