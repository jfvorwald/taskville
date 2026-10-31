# Research: Headless Foundation

Phase 0 decisions for [plan.md](plan.md). Library versions are to be pinned and
re-validated when the workspace is scaffolded; nothing here was installed yet.

## R-1 Runtime and language

- **Decision**: TypeScript 7 on Node.js 26. Run sources directly via Node's built-in
  type stripping in development; typecheck with TypeScript 7's native `tsc --noEmit`; restrict to
  erasable syntax (`erasableSyntaxOnly`: no enums, namespaces, parameter properties).
- **Rationale**: Node 26.8.2 is installed and reports `process.features.typescript === "strip"`,
  so no build step or loader is needed for the engine and CLI.
- **Alternatives**: tsx/ts-node (extra dependency, no longer needed); Bun or Deno
  (would diverge from the ARCHITECTURE.md stack and from the later Vite web client).

## R-2 SQLite driver

- **Decision**: built-in `node:sqlite` with the `Database` and `Statement` classes
  (the `DatabaseSync` and `StatementSync` names are deprecated aliases in Node 26),
  WAL mode, `synchronous=NORMAL`, `foreign_keys=ON`, one writer connection owned by
  the engine, explicit `BEGIN IMMEDIATE`/`COMMIT` (there is no transaction helper).
  Pin a recent Node 26.
- **Rationale**: `node:sqlite` is a release candidate in Node 26 and passed a local WAL
  and transaction test (ARCHITECTURE.md section 5.1). No native addon to compile;
  the synchronous API suits a single-writer transactional ingest. Evidence bodies use
  a second database, `evidence.db` (M2.06).
- **Alternatives**: better-sqlite3 (mature, but a native build per Node major);
  libsql/Turso (remote features not needed). Fallback if `node:sqlite` shows a gap:
  better-sqlite3 has a near-identical synchronous API, so the swap is contained to
  `apps/engine/src/storage`.

## R-3 HTTP server and SSE

- **Decision** (revision 3): Hono 4 on `@hono/node-server`. The Host, Origin, and
  credential checks are middleware applied to every route; request bodies are
  validated with Zod through Hono's validator; SSE uses `streamSSE` with `onAbort`
  cleanup. SSE frames carry `id: <ingestSequence>` so `Last-Event-ID` and `?after=`
  are interchangeable. pino writes structured logs.
- **Rationale**: The security checks are what make browser commands safe, so they
  belong in one tested middleware layer rather than in each hand-written handler.
  `streamSSE` writes wait for the client but have no cap, so the engine keeps its own
  bounded queue of 1,000 frames per subscriber and sends `resnapshot` when it fills.
  Hono 5 is a release candidate, so stay on 4.
- **Alternatives**: hand-written `node:http` router (revision 2's choice: fewer
  dependencies, but security checks and validation hand-rolled); Fastify (heavier
  plugin model); WebSockets (bidirectional is not needed; SSE resumes natively and is
  consumed by `curl` and the CLI).

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
  excluding engine-assigned fields (`eventId`, `receivedAt`, `ingestSequence`), with
  payload strings masked but not yet truncated (R-13).
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
  1x (ambient) or accelerated (tests), a configurable pace (`calm` default,
  `lively`, or custom intervals; FR-013), and a scripted scenario of six agents
  (names as in the mockup: Ada, Pip, Rook, Moss, plus two) cycling assign, work in
  every area, test, handoff, a `needs_you` permission request (`request.opened`,
  never answerable), trouble, and complete, with two subagents and a small team.
  Demo is a producer that posts to the same ingest route with `provenance: "demo"`
  and `sourceId: "demo:<seed>"`, into a project added beforehand.
- **Rationale**: Exercising the real ingest path makes the demo a continuous integration test.

## R-9 Local auth

- **Decision** (ARCHITECTURE.md section 13): bind `127.0.0.1` only; `--host` other
  than loopback is refused. Every route, reads included, rejects a `Host` that is
  not `127.0.0.1:<port>` or `localhost:<port>` (blocks DNS rebinding) and requires a
  credential:
  - CLI token: on first `serve`, a 256-bit token in `$TASKVILLE_HOME/token`
    (mode 0600), sent as `Authorization: Bearer <token>` by the CLI, the demo
    producer, and later the telemetry shim.
  - Browser session: `serve` prints a one-time URL with a pairing code in the URL
    fragment. The page exchanges it at `POST /v1/pairing` for a session secret kept
    in `localStorage` and sent as `X-Taskville-Session`. The engine stores only a
    hash. `taskville unpair` revokes all sessions.
  - Bridge token: a separate file for the permission bridge (M4), valid only on
    the bridge route.
  No cookies are set or read, because browsers share cookies across ports. Any
  `Origin` present must be the engine's own origin, and state-changing browser
  requests must carry it. Commands are accepted only from a browser session; the
  CLI, shim, and bridge tokens never authorize one, because the supervised agent
  runs as the same OS user and can read those files (ARCHITECTURE.md section 9.2).
- **Alternatives**: open reads on loopback (this spec's first draft: any local
  process or rebinding page could read agent activity); cookies (shared across local ports);
  Unix socket (good for the CLI, awkward for browsers and SSE).

## R-10 Spec-kit location

- **Resolved 2026-10-30**: `.specify/`, `.claude/skills/speckit-*`, and `specs/` were
  moved to the Git repository root, so spec paths and code paths share one root.

## R-11 Tooling

- **Decision**: pnpm workspace (pnpm present locally), Vitest 5, Biome 2 for lint and
  format, fast-check for property tests. One `pnpm check` script = typecheck + lint +
  tests; it backs `.claude/check.sh` if the delegation hierarchy is used.

## R-12 Where projects are declared

- **Decision** (default, pending the owner's answer on decision ticket
  [#110](https://github.com/jfvorwald/taskville/issues/110)): the engine's `projects` table is the registry. `taskville
  project add` calls `POST /v1/projects` (CLI token), and the engine inserts the
  project and its `project.created` event in one transaction, so a running engine
  sees the project at once. Projects listed in the config file (M1.11) are
  registered the same way at engine start when absent; `project add` does not edit
  the config file. The built-in Unsorted project is created at first boot.
- **Rationale**: FR-011 needs projects to exist before their events are accepted,
  and the CLI must work against a running engine without a restart. Repository roots
  come only from the CLI or the config file, never from a browser.
- **Alternatives**: the config file as the only registry, with `project add`
  editing it and the engine reloading it (one place to look, but needs a reload path
  and file locking).

## R-13 Attention reasons and redaction (FR-017)

- **Decision**: every payload string except IDs, enums, and timestamps passes
  through the redaction module (`packages/adapters/src/redact`, M1.20) at ingest,
  before commit. `reason` is then cut to 280 characters and stored as
  `{ text, masked, truncated }`. The content hash for duplicate detection is
  computed after masking and before truncation, so reasons that differ only past
  character 280 are a conflict, and the unmasked text is never persisted, not even
  as a hash input. Masking is deterministic, so a retried event still matches as a
  duplicate.
- **Trade-off**: two different reasons that mask to the same text under the same
  source key count as a duplicate rather than a conflict. That is acceptable: the
  stored record is identical either way.
