# Status

Lead-owned cross-session summary. Teammates never edit this file; they write their own report in [tasks/](tasks/) and the lead folds it in here after review and merge.

**Updated:** 2026-10-30 · **Current wave:** 1 (M1 Headless foundation) · **Open gate:** [G1 #19](https://github.com/jfvorwald/taskville/issues/19)

## Where things stand

The pnpm workspace and quality gate are in (PR #108): `pnpm check` runs typecheck, lint and tests in under a second, and CI runs it on every PR and push to main. Spec 001 is aligned with architecture revision 3 (PR #112), so its contracts are now the source for the code tickets. Spike S-1 is in (PR #111): the terminal prompt stays visible while the hook holds, so the recommended hold window is 90 s regardless of viewer focus (decision #116). Spike S-2 is in (PR #118): teammate attribution depends on display mode, and split-pane teammates' prompts never reach the bridge (decision #120). Batch 1 is complete. The engine HTTP core is in (PR #119): Host, Origin and credential checks on every route, single-use browser pairing, and commands refused for every token. Protocol v1 is in (PR #123): Zod schemas for all 34 v1 event types, ingest rejection codes, HTTP and SSE shapes, and a JSON Schema export. Canonical JSON and `stateHash` are in (PR #124): RFC 8785 output with strict input rules and a pure synchronous SHA-256 that matches Web Crypto. Secret redaction is in (PR #127): token formats, private keys, sensitive names and high-entropy values are masked with spans for click-to-reveal. Batch 2 finishes with the config file; batch 3 is running with the event fixtures, the domain reducer and engine storage.

## In progress

| Ticket | Lane | Teammate | State |
| --- | --- | --- | --- |
| [#8](https://github.com/jfvorwald/taskville/issues/8) M1.11 Config file and Taskville home | Engine | engine | in progress |
| [#12](https://github.com/jfvorwald/taskville/issues/12) M1.17 Event fixtures and golden tests | Domain | domain | in progress |
| [#11](https://github.com/jfvorwald/taskville/issues/11) M1.09 Engine storage: SQLite event log and projections | Engine | storage | in progress |
| [#9](https://github.com/jfvorwald/taskville/issues/9) M1.07 Domain reducer: agents, sessions, tasks, activity, teams | Domain | domain-hash | in progress |

Ready, waiting for a free teammate: #10 M1.08 (P0), #94 M1.19.

## Done this wave

| Ticket | PR | roborev | Checks |
| --- | --- | --- | --- |
| [#24](https://github.com/jfvorwald/taskville/issues/24) M1.20 Secret redaction module | [#127](https://github.com/jfvorwald/taskville/pull/127) | 4740: 2 high, 1 medium fixed; re-review 4752: 3 new high fixed; post-commit 4763: 2 high regressions fixed; final post-commit 4783 pass (no third panel, per rule) | adapters 143 tests, `pnpm check` 592 tests on main, CI pass ([report](tasks/M1.20.md)) |
| [#6](https://github.com/jfvorwald/taskville/issues/6) M1.06 Canonical JSON and state hashing | [#124](https://github.com/jfvorwald/taskville/pull/124) | job 4767 pass, no findings | domain 63 tests incl. NIST vectors and isolated-context parity; `pnpm check` 450 tests on main ([report](tasks/M1.06.md)) |
| [#5](https://github.com/jfvorwald/taskville/issues/5) M1.05 Protocol v1 schemas | [#123](https://github.com/jfvorwald/taskville/pull/123) | job 4744 pass; re-review after rebase 4762: 1 medium, 1 low fixed (confirmed by 4769) | protocol 296 tests, `pnpm check` 388 tests, CI pass ([report](tasks/M1.05.md)) |
| [#7](https://github.com/jfvorwald/taskville/issues/7) M1.10 Engine HTTP core, auth, pairing | [#119](https://github.com/jfvorwald/taskville/pull/119) | jobs 4701/4704 and 4724 findings fixed; final 4733 pass | engine 87 tests, `pnpm check` 92 tests, CI pass; mutation check per security rule ([report](tasks/M1.10.md)) |
| [#4](https://github.com/jfvorwald/taskville/issues/4) M1.04 Spike S-2 crews attribution | [#118](https://github.com/jfvorwald/taskville/pull/118) | job 4720: 1 high fixed; re-review 4728 pass (2 low fixed) | `pnpm check` pass; fixtures parse; redaction grep clean; [findings](spikes/S-2-crews.md), [report](tasks/M1.04.md) |
| [#3](https://github.com/jfvorwald/taskville/issues/3) M1.03 Spike S-1 permission hook | [#111](https://github.com/jfvorwald/taskville/pull/111) | job 4680: 1 high, 2 medium fixed; re-review 4694: fixed or answered with evidence; background 4707 pass | `pnpm check` pass; fixture redaction grep clean; [findings](spikes/S-1-permission-bridge.md), [report](tasks/M1.03.md) |
| [#1](https://github.com/jfvorwald/taskville/issues/1) M1.01 Align spec 001 with architecture | [#112](https://github.com/jfvorwald/taskville/pull/112) | job 4675: 2 high fixed; re-review 4684: 1 medium fixed; background reviews of fix commits pass | Done-when grep passes; side-by-side table in [report](tasks/M1.01.md); `pnpm check` 6/6 |
| [#2](https://github.com/jfvorwald/taskville/issues/2) M1.02 Scaffold workspace, quality gate, CI | [#108](https://github.com/jfvorwald/taskville/pull/108) | pass, job 4668, no findings | `pnpm check` 6/6 locally, on a clean clone and in CI ([report](tasks/M1.02.md)) |

## Waiting on the owner

Open decision tickets: [label `waiting:user`](https://github.com/jfvorwald/taskville/issues?q=is%3Aopen+label%3Awaiting%3Auser).

- [#113](https://github.com/jfvorwald/taskville/issues/113) persisted browser pairings are a same-user write path (default: persist digests per spec; alternative: memory only, re-pair after restart). Blocks nothing; the security review #17 weighs it, and it must be settled before `serve` wires pairings to storage.
- [#110](https://github.com/jfvorwald/taskville/issues/110) where projects are registered (default: engine `projects` table, `project add` via `POST /v1/projects`, config projects registered at start). Blocks nothing.
- [#114](https://github.com/jfvorwald/taskville/issues/114) ARCHITECTURE.md 7.4 vs 6 on `pending_requests`/`commands` tables (default: projection-only, M4; text unchanged). Blocks nothing.
- [#116](https://github.com/jfvorwald/taskville/issues/116) S-1: hold window (default 90 s, focus-independent, hook timeout hold + 5 s) and terminal-answer rules that would change ARCHITECTURE.md 8.1 and the `.roborev.toml` bridge invariant. Blocks nothing in M1; feeds M4.02 and M4.03.
- [#120](https://github.com/jfvorwald/taskville/issues/120) S-2: teammate attribution by display mode (default: in-process by `agent_id`; split-pane as own session, heuristic "for: <name>" red state, no Allow or Deny). Blocks nothing in M1; feeds M2.04 and M5.

 Items there are blocking only if the ticket says so; everything else proceeds on its stated default.

## Measurements

| What | Value | Command | Ticket |
| --- | --- | --- | --- |
| `.claude/check.sh` wall time, clean clone | 0.72 s | `time ./.claude/check.sh` (macOS, Node 26.8.2, pnpm 12.4.2) | #2 |
| Redaction, adversarial 100,000-char inputs | at most 27 ms each alone (23 inputs); up to 285 ms under parallel `pnpm check` | adapters test suite | #24 |
| Hash a 759,588-byte state | about 9.6 ms (mean of 20 runs) | one-off script, not committed (Node 26.8.2) | #6 |
| Notification `permission_prompt` delay after PermissionRequest | 6.011 to 6.016 s (3 runs) | spike server log, Claude Code 2.1.312 | #3 |
| Terminal No to hook connection close | 15 ms (1 run) | spike server log | #3 |

Targets in the spec are not measurements until a ticket records them here with the command that produced them.

## Known follow-ups

- Flakes: F-1 (M1.20 timing bound under parallel load, fixed by raising the bound; L-19).
- M1.20 for ingest (#13): strip control characters before redacting so spans match stored text; the 280-character cut can split a marker (the UI must not assume whole markers). Accepted false negative: unquoted letters-only `password: value`; accepted false positive: upper-case `*_KEY` names always masked.

- M1.06: `stateHash` format is `<reducerVersion>:<hex>` (the `:` separator is a choice; R-7 only says prefixed). The domain import scan covers imports only; #9 extends it to clock, randomness and host globals.

- M1.05: engine `http/errors.ts`, `/health` and pairing bodies duplicate shapes now in `@taskville/protocol`; the engine should import them (candidate follow-up ticket). Ingest (#13) decides whether the batch route forces `late: false`. data-model.md's agent kind list lacks `unknown` (the protocol follows ARCHITECTURE.md 6). If G1 keeps the S-2 heuristics, M2 needs a protocol flag such as `parentHeuristic`.

- M1.10: pairing sessions are stored behind an interface, in memory until M1.09 (#11) backs it with the `pairings` table; `/health` reports `db`, `walMode`, `version` once `serve` (#16) passes them in. Pairing codes are 256-bit (contract says 128-bit; stronger).

- S-2 NOT RUN: TaskCreated/TaskCompleted (task tools unavailable in 2.1.312), Elicitation, StopFailure, PermissionDenied, and a recorded payload from a user-settings hook fired by a teammate (steps for the owner in the findings doc).
- Spike sessions added folder-trust entries to `~/.claude.json` and fired user-level hooks once (L-11); owner to decide whether to clean them.

- #12 (M1.17): quickstart now expects `invalid.jsonl` to include an `unknown_project` line.
- Spec 001 defaults where the architecture gives none: silent-trouble threshold 10 min, `inputPreview` 2,000 chars, input reason 4,000 chars before truncation, custom `--pace` syntax (see [M1.01 report](tasks/M1.01.md)).

- Nothing yet enforces that `packages/protocol`, `domain` and `adapters` import no Node built-ins (one shared tsconfig with `types: ["node"]`). Owning tickets (#5, #6, #24) add a package-local test for it.
- Packages still carry M1.02 placeholder tests; owning tickets remove them when real tests land.

## Next

Merge batch 2 as it lands; next free slots go to #10, then #94; #9, #10, #11, #12 once #5 and #6 merge. See [ROADMAP.md](ROADMAP.md).
