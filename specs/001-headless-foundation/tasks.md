---
description: "Task list for feature 001, mirroring GitHub milestone M1"
---

# Tasks: Headless Foundation

**Input**: Design documents from `specs/001-headless-foundation/`

**Source of truth**: the GitHub issues in milestone [M1 Headless foundation](https://github.com/jfvorwald/taskville/milestone/1). Each task below mirrors one issue; the issue holds the full scope and "Done when". If they disagree, the issue wins and this file is corrected.

**Tests**: required for every task (constitution VI): the failing test lands first.

## Format: `[ID] [P?] [Story] Description`

- **[P]**: can run in parallel (different files, no dependency on an incomplete task)
- **[Story]**: user story from spec.md (US1 ingest and inspect, US2 follow and resume, US3 demo)

## Phase 1: Setup

- [ ] T001 Scaffold pnpm workspace, `pnpm check`, `.claude/check.sh`, CI in package.json, pnpm-workspace.yaml, tsconfig.base.json, biome.json, .github/workflows/ci.yml ([#2](https://github.com/jfvorwald/taskville/issues/2), M1.02)
- [ ] T002 [P] Align spec 001 documents with architecture revisions 2 and 3 in specs/001-headless-foundation/ ([#1](https://github.com/jfvorwald/taskville/issues/1), M1.01)
- [ ] T003 [P] Retro report generator in scripts/retro/ ([#94](https://github.com/jfvorwald/taskville/issues/94), M1.19)

## Phase 2: Foundational

- [ ] T004 [P] Spike S-1 PermissionRequest behavior in docs/spikes/S-1-permission-bridge.md and fixtures/claude-code/permission/ ([#3](https://github.com/jfvorwald/taskville/issues/3), M1.03)
- [ ] T005 [P] Spike S-2 subagent and team attribution in docs/spikes/S-2-crews.md and fixtures/claude-code/ ([#4](https://github.com/jfvorwald/taskville/issues/4), M1.04)
- [ ] T006 Protocol v1 schemas in packages/protocol/ ([#5](https://github.com/jfvorwald/taskville/issues/5), M1.05)
- [ ] T007 [P] Canonical JSON and state hashing in packages/domain/src/hash/ ([#6](https://github.com/jfvorwald/taskville/issues/6), M1.06)
- [ ] T008 [P] Config file and Taskville home in apps/engine/src/config/ ([#8](https://github.com/jfvorwald/taskville/issues/8), M1.11)
- [ ] T009 [P] HTTP core, auth, and browser pairing in apps/engine/src/http/ and apps/engine/src/auth/ ([#7](https://github.com/jfvorwald/taskville/issues/7), M1.10)
- [ ] T010 SQLite event log and projections in apps/engine/src/storage/ ([#11](https://github.com/jfvorwald/taskville/issues/11), M1.09)
- [ ] T011 [P] Event fixtures and golden tests in fixtures/events/ ([#12](https://github.com/jfvorwald/taskville/issues/12), M1.17)
- [ ] T021 [P] Secret redaction module in packages/adapters/src/redact/ ([#24](https://github.com/jfvorwald/taskville/issues/24), M1.20; FR-017)

**Checkpoint**: protocol, storage, and HTTP core exist; stories can proceed.

## Phase 3: User Story 1 - Ingest agent events and see who is doing what (P1)

**Independent test**: ingest a fixture with the CLI and compare `status --json` to the golden output.

**Not shippable alone (analysis finding F1, accepted)**: T015 also delivers US2's
`events follow`, so US1's CLI waits on US2's SSE ticket T016. US1's domain and ingest
work (T012 to T014) can still be verified on their own through engine tests.

- [ ] T012 [US1] Domain reducer for agents, sessions, tasks, activity, teams in packages/domain/src/reducer/entities/ ([#9](https://github.com/jfvorwald/taskville/issues/9), M1.07)
- [ ] T013 [P] [US1] Attention, requests, and commands in packages/domain/src/reducer/attention/ and packages/domain/src/selectors/ ([#10](https://github.com/jfvorwald/taskville/issues/10), M1.08)
- [ ] T014 [US1] Ingest pipeline, including `unknown_project` and reason masking (needs T021), in apps/engine/src/ingest/ ([#13](https://github.com/jfvorwald/taskville/issues/13), M1.12)
- [ ] T015 [US1] CLI serve, project add/list, status (indented tree), events, requests in apps/cli/src/ ([#16](https://github.com/jfvorwald/taskville/issues/16), M1.14; also covers US2 `events follow`, so it waits on T016)

## Phase 4: User Story 2 - Follow a project live and resume without gaps (P2)

**Independent test**: snapshot at N, disconnect, ingest, resume from N; no gaps or repeats.

- [ ] T016 [US2] Snapshots and resumable SSE streams in apps/engine/src/stream/ ([#15](https://github.com/jfvorwald/taskville/issues/15), M1.13)

## Phase 5: User Story 3 - Deterministic six-agent demo (P3)

**Independent test**: `demo run --offline --seed 42` twice gives the same hash.

- [ ] T017 [P] [US3] Seeded demo producer with configurable pace in packages/demo/ ([#14](https://github.com/jfvorwald/taskville/issues/14), M1.15)
- [ ] T018 [US3] CLI demo commands in apps/cli/src/commands/demo* ([#18](https://github.com/jfvorwald/taskville/issues/18), M1.16)

## Phase 6: Polish and cross-cutting

- [ ] T022 Performance and soak checks for SC-004, SC-005, SC-006 in tests/perf/ ([#103](https://github.com/jfvorwald/taskville/issues/103), M1.21)
- [ ] T019 Security review of engine HTTP, auth, pairing, ingest ([#17](https://github.com/jfvorwald/taskville/issues/17), M1.18)
- [ ] T020 Milestone retrospective in docs/retros/M1.md and docs/LESSONS.md ([#95](https://github.com/jfvorwald/taskville/issues/95), M1.RT)

## Dependencies

Blocking relationships are recorded as GitHub issue dependencies; see [docs/ROADMAP.md](../../docs/ROADMAP.md) for the parallel batches. Gate [G1 #19](https://github.com/jfvorwald/taskville/issues/19) waits on all of the above.
