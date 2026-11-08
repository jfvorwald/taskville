# M8 imports: archive timelines (design)

**Date:** 2026-11-08 · **Author:** lead · **Milestone:** M8 Post-release: imports and replies · **Gate:** G8 #93

The owner closed G7 on 2026-11-08 ("autoaccept everything"), which released M8. ARCHITECTURE.md already fixes the shape: imported history never merges into the live timeline (7.3); each import is its own read-only **archive timeline** ordered by occurrence time, then source sequence, then event ID; the `archives` table belongs to storage (7.4); `GET /v1/projects/:id/timelines`, the timeline routes and `POST /v1/imports`, `GET /v1/imports/:id` are in the API (10); import paths come only from configured repository roots, and transcripts are evidence, never instructions (13). This note fills in the parts M8.01 and M8.02 do not own, so they can be built in parallel. No ARCHITECTURE change. Updated after the wave 1 reviews (2026-11-08).

## Contract (already on the foundation branch)

`apps/engine/src/importers/types.ts`: an `Importer` is `{ kind: "git" | "transcripts", run(context) }`, an async generator of `ImportBatch { events: InputEventWire[], evidence?: ToolEvidence[] }` that returns final `ImportCounts { read, imported, skipped, malformed }`. Events are protocol v1 input events with `provenance: "imported"`, stable `sourceEventId`s, source `occurredAt`, and `sourceSequence` where the source has an order. Importers are pure producers: they read the source, never write anything, and never touch storage.

## Storage (M8.06)

A new migration adds:

- `archives`: `id` (uuid), `project_id`, `kind` (`git` or `transcripts`), `label` (for example `git: <root basename>`), `root`, `status` (`running`, `done`, `failed`, `cancelled`), `created_at`, `finished_at`, `counts_json`, `error` (a code and a short message, never source text), `event_count`, `first_at`, `last_at`.
- `archive_events`: `archive_id`, `position` (1..n, gap-free), `event_id` (unique), `source_id`, `source_event_id`, `source_sequence`, `occurred_at`, `type`, `content_hash`, `envelope_json`; primary key `(archive_id, position)`, unique `(archive_id, source_id, source_event_id)`.

The job runner validates every event with the protocol parser (invalid events count as malformed, with the rejection code, and are not stored; an event over 64 KB serialized is `payload_too_large`; a repeated source key with identical content is skipped and with different content is a `conflict`), assigns engine IDs, sorts by `occurredAt`, then `sourceSequence` (absent sorts first), then `sourceEventId` (the event ID is random, so the stable source key breaks the last tie), and writes the archive in one transaction at the end. A failed or cancelled import leaves its row with no events. An archive is immutable once `done`; importing again creates a new archive. Evidence goes through the existing evidence store (redaction, 64 KB bodies), scoped to the archive so it never shadows or evicts live bodies, held in memory only for kept events within a per-import byte budget, and written only after the archive completes; dropped items are counted in `evidenceDropped`. Live events, projections and the live head are never touched. Cap: 200,000 events per archive; past it the importer is stopped, the archive finishes `done` with `truncated: true`. One import runs engine-wide at a time; the runner yields to the event loop between batches.

## Imports API (M8.06)

- `POST /v1/imports` with `{ projectId, kind, root }`. CLI token only (the browser does not start imports in M8; a paired session gets `403 credential_not_allowed`, like the bridge token). `root` must equal one of the project's configured roots after `realpath`, else `400 root_not_configured`. One running import engine-wide, else `409 import_running`; after shutdown begins, `503 engine_closing`. Answers `202 { importId, archiveId, status: "running" }` and runs the job off the request.
- `GET /v1/imports/:id`: CLI token or paired session. `{ importId, archiveId, projectId, kind, status, counts, error?, startedAt, finishedAt? }`. The import ID equals the archive ID.
- Importers register by kind; the engine wires the Git importer (M8.01) and the transcript importer (M8.02) once they land. Until then a kind with no importer answers `400 unknown_import_kind`.

## Archive timelines (M8.07)

- `GET /v1/projects/:id/timelines` lists the live recording first, then archives with `status: "done"`, newest first: `{ id: "archive:<archiveId>", kind: "archive", archiveKind, label, projectId, firstSequence: 1, lastSequence: event_count, firstAt, lastAt, eventCount }`.
- `GET /v1/timelines/:id/state` and `/events` accept `archive:<id>` with the same contracts as the live timeline, except that positions are archive positions and a timestamp resolves against `occurredAt` (an archive's clock), and `attention` is always empty (archives are historical and never need you). Replay uses the same reducer. Checkpoints are not added (seeks are measured first, as in 7.4).
- `404 not_found` for an unknown or not-done archive.

## CLI (M8.08)

`taskville import git [--project <id>] [--root <path>]` and `taskville import transcripts [--project <id>] [--root <path>]`. Defaults: the project whose configured root contains the current directory, and that root. Starts the import, then polls `GET /v1/imports/:id` and prints progress and final counts; `--json` prints the final record; exit 0 on `done`, 1 otherwise. `taskville status` is unchanged.

## Importers

- **Git (M8.01, `apps/engine/src/importers/git/**`):** read-only `git rev-list --topo-order --reverse` plus `git log` and `for-each-ref` through the existing `runGit` runner (timeouts, output caps). Commits become `git.commit` (merges also `git.merge`), refs become `git.ref_moved`, `occurredAt` is the committer date, `sourceSequence` the topological index, so conflicting timestamps still order parents before children within equal times and keep a deterministic order otherwise. `sourceId` is `git:<short hash of the realpath>`, the live watcher's scheme (a raw path could exceed the 200-character ID limit). Commits come from branches, tags, remote-tracking refs and HEAD; ref events only for local branches and tags. Log records are NUL-framed. Changed-file summaries need payload fields the protocol lacks; M8.01 adds optional `files: { added, modified, deleted, renamed }` counts to `git.commit` in `packages/protocol` (an additive, optional field; allowed outside Owns, say so in the PR). No author emails. Git-only facts: every event of a `git` archive is a Git fact; nothing in it is attributed to an agent.
- **Transcripts (M8.02, `packages/adapters/src/claude-code/transcripts/**`, `apps/engine/src/importers/transcripts/**`):** reads Claude Code session transcripts for one configured root: `<claude config dir>/projects/<slug of root>/*.jsonl`, where the config dir is `CLAUDE_CONFIG_DIR` or `~/.claude`, read-only. Each line is parsed tolerantly (bad JSON, truncated last lines and unknown shapes count as malformed, never abort the import). Lines map to the same event types the hook adapter produces (session started, prompt submitted, tool call started and finished, turn ended, subagents; `session.ended` is never inferred, and a subagent's parent is set only when the transcript links it to an Agent or Task call). A file is read only if its first `cwd` is the root or inside it (slugs collide), lines over 8 MiB count as malformed, files open without following symlinks, and event IDs are file-scoped with `sourceId: "claude-code:transcript"`; prompt and tool text is evidence, redacted and bounded through the evidence store, never a quip and never rendered as markup. Tests use fixture transcripts under a temporary config dir; no test or run reads the real `~/.claude`.

## History UI (M8.03, wave 2)

`apps/web/src/history/archives/**`: a timeline picker in history mode (live recording, then archives), opening an archive reads its state and events through the same routes, Git-only facts are visibly distinct (their own tick style and a "Git" chip, no agent cards), and "Back to live" returns to live from an archive. Playwright: open an archive, scrub, return to live.

## Spikes

- **M8.04 typed replies (`docs/spikes/S-4-replies.md`):** a throwaway channel MCP server in a temporary project with project-scoped settings; confirm addressing, sender allowlist, consent and how replies arrive; security implications; go or no-go.
- **M8.05 Codex adapter (`docs/spikes/S-5-codex.md`, `fixtures/codex/**`):** record Codex hook and OpenTelemetry output for a short session with tool calls in a throwaway project with project-scoped config; map it to Taskville events; list gaps; go or no-go. Fixtures redacted.

## Tickets and order

| Key | Work | Owns | After |
| --- | --- | --- | --- |
| M8.06 | archives storage, job runner, imports API | `apps/engine/src/storage/**`, `apps/engine/src/importers/{index,jobs,routes}.ts` and tests, `apps/engine/src/http/**` (route registration only), `packages/protocol/src/api.ts` | contract |
| M8.07 | archive timelines in the timeline routes | `apps/engine/src/timelines/**` | M8.06 storage |
| M8.08 | `taskville import` CLI | `apps/cli/src/commands/import*` and its registration | M8.06 API |
| M8.01 | Git importer | `apps/engine/src/importers/git/**`, optional `files` on `git.commit` | contract |
| M8.02 | transcript importer | `packages/adapters/src/claude-code/transcripts/**`, `apps/engine/src/importers/transcripts/**` | contract |
| M8.03 | archives in the history UI | `apps/web/src/history/archives/**` | M8.07 |
| M8.04, M8.05 | spikes | their docs and fixtures | none |

Wiring the two importers into the engine's importer registry is a one-line change each, done in whichever of M8.01, M8.02 or M8.06 merges last, with an integration test that imports a fixture through `POST /v1/imports` and reads it back through the archive timeline.
