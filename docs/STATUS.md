# Status

Lead-owned cross-session summary. Teammates never edit this file; they write their own report in [tasks/](tasks/) and the lead folds it in here after review and merge.

**Updated:** 2026-10-31 · **Current wave:** 2 (M2 Claude Code telemetry), in progress · **Open gate:** none; next is [G2 #40](https://github.com/jfvorwald/taskville/issues/40)

## Where things stand

**G1 closed by the owner on 2026-10-31 ("Reviewed, all good"); M2 has started.** All eleven G1 decision tickets were answered and are applied (a comment on each says what changed). M3 (also wave 2 in the roadmap) is not started yet; the owner asked for M2.

Applied from the G1 answers:

- #116 defaults: ARCHITECTURE.md 6 and 8.1 and the `.roborev.toml` bridge invariant now say hold 90 s focus-independent, hook timeout hold + 5 s, terminal No is a deny, one unambiguous matching PostToolUse is a terminal allow, city decisions are "sent, unconfirmed" until telemetry confirms (this PR).
- #163 D1 alternative: new ticket [#173](https://github.com/jfvorwald/taskville/issues/173) (M2.12, fresh pairing link from a running `serve`, plus persisted pairings wired per #113). The mechanism is follow-up decision [#174](https://github.com/jfvorwald/taskville/issues/174), defaulting to a keypress in the `serve` terminal, because a CLI-token route that mints codes would reopen the self-approval path #113 closed.
- #120 defaults, plus the D2 alternative as an optional setting: new ticket [#175](https://github.com/jfvorwald/taskville/issues/175) (M5.13, strict teammate attribution). M2.04 marks every heuristic link so the setting can hide it.
- #168 defaults: SC-006 stays on RSS and stays a MISS; #166, #167 and #143 are scheduled into M2.
- G1 retro proposal 4 applied: task reports gain a `**Review outcome:**` line (docs/tasks/README.md).

`pnpm check` on main at b927183: 66 files, 1,287 tests pass; CI green.

## In progress

| Ticket | Teammate | Notes |
| --- | --- | --- |
| [#22](https://github.com/jfvorwald/taskville/issues/22) M2.03 Adapter: sessions, tool calls, notifications | adapter-core | owns the `@taskville/adapters/claude-code` entry and `mapClaudeCodeHook` |
| [#23](https://github.com/jfvorwald/taskville/issues/23) M2.04 Adapter: subagents and agent teams | adapter-crew | wires into the index after #22 merges |
| [#20](https://github.com/jfvorwald/taskville/issues/20) M2.01 Telemetry hook shim with spool | shim | defines the wrapper body and spool line format |
| [#21](https://github.com/jfvorwald/taskville/issues/21) M2.02 Claude Code source endpoint | engine-source | mapper and evidence sink injected until #22 and #27 merge |

Next as slots free: #27 M2.06 evidence store, #25 M2.09 Git watcher, #143 and #167 (domain follow-ups), then batch 2 (#28 M2.07, #29 M2.08, #173 M2.12), batch 3 (#34 M2.10, #35 M2.11), and #96 M2.RT.

## Done this wave

Nothing merged in wave 2 yet.

## Done in wave 1 (M1)

| Ticket | PR | roborev | Checks |
| --- | --- | --- | --- |
| [#95](https://github.com/jfvorwald/taskville/issues/95) M1.RT Retrospective and lessons | [#171](https://github.com/jfvorwald/taskville/pull/171) | job 5020 pass, no findings | `pnpm retro M1` (written sections preserved on re-run); `pnpm check` 1287 tests ([retro](retros/M1.md), [report](tasks/M1.RT.md)) |
| [#103](https://github.com/jfvorwald/taskville/issues/103) M1.21 Performance and soak checks | [#169](https://github.com/jfvorwald/taskville/pull/169) | 5005: 3 medium fixed; re-review 5011: 1 medium fixed; post-commit 5007: 1 medium fixed | SC-004 and SC-005 pass; SC-006 MISS filed as #166 ([report](tasks/M1.21.md)) |
| [#14](https://github.com/jfvorwald/taskville/issues/14) M1.15 fix: demo parsers reject non-finite values | [#159](https://github.com/jfvorwald/taskville/pull/159) | 4979 pass, no findings | demo 97, CLI 60, `pnpm check` 1278 tests on main ([report](tasks/M1.15-fix.md)) |
| [#18](https://github.com/jfvorwald/taskville/issues/18) M1.16 CLI demo commands | [#156](https://github.com/jfvorwald/taskville/pull/156) | 4957: 1 medium fixed; re-review 4962: 1 high, 1 medium fixed; post-commit 4964 pass | CLI 60 tests incl. `demo start` against a real `serve`; `pnpm check` 1203 tests on main ([report](tasks/M1.16.md)) |
| [#16](https://github.com/jfvorwald/taskville/issues/16) M1.14 CLI: serve, status, events, requests | [#153](https://github.com/jfvorwald/taskville/pull/153) | 4918: 2 high, 1 medium fixed; re-review 4924: 1 medium fixed; post-commit 4931: 1 medium fixed | CLI 39 tests incl. quickstart goldens, engine 266, `pnpm check` 1182 tests on main; first CI run failed on the merge ref, fixed ([report](tasks/M1.14.md)) |
| [#17](https://github.com/jfvorwald/taskville/issues/17) M1.18 security fixes F4, F6 (pairing code TTL, opener values) | [#164](https://github.com/jfvorwald/taskville/pull/164) | 4990: 1 medium answered with evidence; re-review 4995 pass | engine and CLI 343 tests, `pnpm check` 1287 tests on main ([report](tasks/M1.18-F4.md)) |
| [#17](https://github.com/jfvorwald/taskville/issues/17) M1.18 security fix F3 (redaction gaps) | [#158](https://github.com/jfvorwald/taskville/pull/158) | 4935: 2 high; re-review 4945: 3 high; post-commit 4950, 4958, 4965: 7 high; all fixed test-first; 4970 pass | adapters 213 tests, 41 adversarial inputs within 30 ms; `pnpm check` 1273 tests on main ([report](tasks/M1.18-F3.md)) |
| [#17](https://github.com/jfvorwald/taskville/issues/17) M1.18 security fixes F1, F2, F5 | [#152](https://github.com/jfvorwald/taskville/pull/152) | 4930 pass, no findings | engine 253 tests, `pnpm check` 1123 tests on main; a mutation per fix ([report](tasks/M1.18-F1.md)) |
| [#15](https://github.com/jfvorwald/taskville/issues/15) M1.13 Snapshots and resumable SSE streams | [#149](https://github.com/jfvorwald/taskville/pull/149) | 4903 pass; re-review 4909 pass; post-commit 4899 (1 high, 1 medium) and 4906 (1 medium) fixed | engine 245 tests (31 stream) incl. crash-resume, 100 disconnect cycles, slow consumer; `pnpm check` 1115 tests on main ([report](tasks/M1.13.md)) |
| [#14](https://github.com/jfvorwald/taskville/issues/14) M1.15 Seeded six-agent demo producer | [#146](https://github.com/jfvorwald/taskville/pull/146) | 4876: 4 medium fixed; re-review 4882: 2 medium fixed; post-commit 4886 pass | demo 92 tests incl. US3-2 over 20 seeds; `pnpm check` 1084 tests on main ([report](tasks/M1.15.md)) |
| [#13](https://github.com/jfvorwald/taskville/issues/13) M1.12 Ingest pipeline | [#145](https://github.com/jfvorwald/taskville/pull/145) | 4872 and post-commit: 2 medium, several low fixed; re-review 4885 pass (1 low fixed) | engine 214 tests (41 ingest) incl. golden fixtures, concurrency; `pnpm check` 993 tests on main; mutation checks ([report](tasks/M1.12.md)) |
| [#9](https://github.com/jfvorwald/taskville/issues/9) M1.07 Domain reducer and composition with M1.08 | [#139](https://github.com/jfvorwald/taskville/pull/139) | 4818: 5 medium fixed; re-review 4831: 3 fixed, 1 answered; 4838 (third raise of one finding) routed to #138; post-commit 4861 pass | domain 203 tests, `pnpm check` 952 tests on main; fixture replay snapshots ([report](tasks/M1.07.md)) |
| [#94](https://github.com/jfvorwald/taskville/issues/94) M1.19 Retro tooling: milestone report generator | [#141](https://github.com/jfvorwald/taskville/pull/141) | 4844: 4 medium fixed; re-review 4851: 1 high, 1 medium fixed; post-commit 4852: 1 high, 1 medium fixed; 4853 pass | retro 109 tests incl. golden report and Mermaid validation; `pnpm check` 877 tests ([report](tasks/M1.19.md)) |
| [#10](https://github.com/jfvorwald/taskville/issues/10) M1.08 Domain attention, requests, and commands | [#137](https://github.com/jfvorwald/taskville/pull/137) | job 4827: 1 medium fixed; re-review 4836 pass | domain 128 tests, `pnpm check` 768 tests on main; mutation check per security rule ([report](tasks/M1.08.md)) |
| [#11](https://github.com/jfvorwald/taskville/issues/11) M1.09 Engine storage: SQLite event log and projections | [#134](https://github.com/jfvorwald/taskville/pull/134) | job 4815 pass, no findings | engine 173 tests (43 storage), `pnpm check` 703 tests on main; mutation check per safeguard ([report](tasks/M1.09.md)) |
| [#12](https://github.com/jfvorwald/taskville/issues/12) M1.17 Event fixtures and golden tests | [#130](https://github.com/jfvorwald/taskville/pull/130) | job 4797 pass, no findings | protocol 322 tests incl. golden fixtures and a mutation check; `pnpm check` 660 tests on main ([report](tasks/M1.17.md)) |
| [#8](https://github.com/jfvorwald/taskville/issues/8) M1.11 Config file and Taskville home | [#128](https://github.com/jfvorwald/taskville/pull/128) | 4776: symlinked-home chmod fixed; final 4781 pass | engine 130 tests, `pnpm check` 635 tests on main, CI pass; mutation checks on opener and file modes ([report](tasks/M1.11.md)) |
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

- [#174](https://github.com/jfvorwald/taskville/issues/174) how a running `serve` issues a fresh pairing link (default: keypress in the `serve` terminal; alternative: `taskville pair` over a CLI-token route). Blocks nothing; #173 builds on the default.
- [#176](https://github.com/jfvorwald/taskville/issues/176) milestones after M1 have no spec-kit feature, which the constitution's workflow expects (default: tickets plus ARCHITECTURE.md and the spec 001 contracts are M2's contract; alternative: pause and write spec 002). Blocks nothing.

Items there are blocking only if the ticket says so; everything else proceeds on its stated default.

## Measurements

| What | Value | Command | Ticket |
| --- | --- | --- | --- |
| `.claude/check.sh` wall time, clean clone | 0.72 s | `time ./.claude/check.sh` (macOS, Node 26.8.2, pnpm 12.4.2) | #2 |
| Redaction, adversarial 100,000-char inputs | at most 27 ms each alone (23 inputs); up to 285 ms under parallel `pnpm check` | adapters test suite | #24 |
| `pnpm check` wall time (36 files, 768 tests) | 8.1 s | `time pnpm check` (macOS, Node 26.8.2) | #10 |
| Live `pnpm retro M1` | 7.2 s | `time pnpm retro M1` | #94 |
| `demo run --seed 42 --duration 2h --offline` (quickstart section 4) | same hash twice, 0.24 s | by hand, Node 26.8.2 | #18 |
| Offline 8-hour calm demo run | 127 ms | demo test suite (Node 26.8.2) | #14 |
| SC-004 batch over HTTP to real `serve` | median 155.8 ms, max 205.4 ms (5 runs); target under 1 s: PASS | `pnpm perf batch` (Apple M1, 16 GiB, Node 26.8.2) | #103 |
| SC-005 ingest to SSE viewer | idle median 1.7 / p95 4.0 / max 15.1 ms; with demo median 2.2 / p95 6.1 / max 44.9 ms (1,000 probes each); target under 250 ms: PASS | `pnpm perf latency` | #103 |
| SC-006 RSS growth hour 1 to 8, calm demo at 480x | 14.1%, rerun alone 26.6%; target under 10%: MISS (#166); heap after GC flat 16.6 to 16.7 MiB (diagnostic, not committed) | `pnpm perf soak` | #103 |
| Ingest a 1,000-event batch (SC-004) | median 63.0 ms over 5 runs (56.9 to 88.0 ms), about 15,900 events/s | `pnpm --filter @taskville/engine run bench:ingest` (macOS, Node 26.8.2); reported, not gated | #13 |
| Replay 10,012 events / hash result | 51 ms / 5.9 ms (one run) | throwaway script, Node 26.8.2 | #9 |
| Hash a 759,588-byte state | about 9.6 ms (mean of 20 runs) | one-off script, not committed (Node 26.8.2) | #6 |
| Notification `permission_prompt` delay after PermissionRequest | 6.011 to 6.016 s (3 runs) | spike server log, Claude Code 2.1.312 | #3 |
| Terminal No to hook connection close | 15 ms (1 run) | spike server log | #3 |

Targets in the spec are not measurements until a ticket records them here with the command that produced them.

## Known follow-ups

- [#166](https://github.com/jfvorwald/taskville/issues/166) SC-006 RSS miss; [#167](https://github.com/jfvorwald/taskville/issues/167) projection state grows without bound. Not on the G1 list; raised for the owner to schedule.
- Quickstart run by hand on main on 2026-10-31: all steps behave as specified; two stale expectations corrected (L-42).

- Security review #17: all six findings fixed and merged (#152, #158, #164); #17 closed. M4's command service must catch `OpenerValueError` from `renderOpener`. No exchange attempt limit (the code is 256-bit, valid 10 minutes).

- M1.18 F3 accepted false positives: `docker run -u 1000:1000` masks the group, `rsync -u host:/srv` masks the path, a curl line with a Digest header is masked to its end (#160 D2).

- M1.14: `POST /v1/projects` lives in `apps/engine/src/projects/` (CLI token, `projects` scope; decision #110 default). Pairings stay in memory (#113 open). Usage errors exit 1 (cli.md names no code); oversized lines are rejected as `event_too_large` by line number. NOT RUN: Windows; a pairing round trip from a real browser.
- CI failures: F-CI-1, PR #153's first run (merge ref after #152 changed `bootEngine`), fixed in the PR.

- M1.18 F5 residual: a client that stalls before catching up on the backlog is not cut off (memory bounded, sockets capped at 64, no write timeout in that phase). `bootEngine` now requires `pairing`. NOT RUN: real file-descriptor exhaustion.

- Security review #17: F3 (redaction misses `Authorization: Token` and `curl -u`) is rated medium as the redactor is heuristic; `.roborev.toml` would rate a broken masking invariant high. Fixed before G1 either way. The reviewer recommends memory-only pairings for #113. Reviewer NOT RUN: engine tests and probe scripts (read-only shell); each fix PR reproduces its finding with a failing test.

- M1.13: `resnapshot` with `reducer_rebuilt` is never sent (rebuilds run only at boot). `apps/engine/src/http/errors.ts` gained `unknown_project`. NOT RUN: a real browser client (Node `fetch` streaming stands in).

- M1.15: demo needs-you moments are telemetry-only requests ("Open session" only, never Allow), since only `taskville:bridge` requests are answerable. Offline hashes are not comparable to engine-run hashes (the engine assigns event IDs and receive times). NOT RUN: posting to a real engine and wall-clock pacing at 1x (both land with #18).

- M1.12: control-character stripping keeps tab and line feed (events.md only says "stripped"); producer-set `late: true` is passed through (default); `POST /v1/projects` left to #16.

- [#143](https://github.com/jfvorwald/taskville/issues/143): the attention reducer orders requests with `Date.parse`, which feeds `stateHash`; switch to `compareTimestamps`. Not on the G1 list; raised for the owner to schedule.

- M1.19: NOT RUN: rendering through real Mermaid (a strict local validator is used) and flake counting on real data (none yet). Re-recording the snapshot needs `biome check --write` on it.

- M1.08: requests and commands are never pruned from state; the soak check (#103) should watch it. Closure edge case: a parallel tool call's `PostToolUse` in the same session closes a pending prompt as `answered_elsewhere` (#135 D2). Test envelope builders duplicated across attention and reducer tests (cleanup after #9).

- M1.09: the `pairings` table and `SqlitePairingRecords` exist but are not wired (decision #113). `serve` (#16) boot order: `openStorage`, `ensureUnsortedProject`, `rebuildStaleProjections(storage, reducer)`, listen. Ingest (#13) passes masked, untruncated fields to `clientContentHash`.

- M1.17: expected reducer snapshots deferred to #9 (no contract defines them yet); a non-JSON line is expected as `invalid_envelope` (events.md names no code); the reference model checks producer policy before `unknown_project`, an order the fixtures do not pin.

- M1.11: default port 4807; config projects registered at start (decision #110 default); POSIX-only file modes (Windows NOT RUN).

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

The owner reviews G1 (#19): the retro, the S-1 and S-2 findings, the security review on #17, the quickstart, and the timing numbers; decides #116 (hold window) and #120 (teammate attribution) plus the other open decisions; and closes #19 to release M2 and M3 (wave 2). Proposed process changes and follow-ups #143, #166, #167 are listed in the G1 summary.
