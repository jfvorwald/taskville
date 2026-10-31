# Status

Lead-owned cross-session summary. Teammates never edit this file; they write their own report in [tasks/](tasks/) and the lead folds it in here after review and merge.

**Updated:** 2026-10-30 · **Current wave:** 1 (M1 Headless foundation) · **Open gate:** [G1 #19](https://github.com/jfvorwald/taskville/issues/19)

## Where things stand

The pnpm workspace and quality gate are in (PR #108): `pnpm check` runs typecheck, lint and tests in under a second, and CI runs it on every PR and push to main. Spec 001 is aligned with architecture revision 3 (PR #112), so its contracts are now the source for the code tickets. Spike S-1 is in (PR #111): the terminal prompt stays visible while the hook holds, so the recommended hold window is 90 s regardless of viewer focus (decision #116). Spike S-2 is in (PR #118): teammate attribution depends on display mode, and split-pane teammates' prompts never reach the bridge (decision #120). Batch 1 is complete. The engine HTTP core is in (PR #119): Host, Origin and credential checks on every route, single-use browser pairing, and commands refused for every token. Protocol v1 is in (PR #123): Zod schemas for all 34 v1 event types, ingest rejection codes, HTTP and SSE shapes, and a JSON Schema export. Canonical JSON and `stateHash` are in (PR #124): RFC 8785 output with strict input rules and a pure synchronous SHA-256 that matches Web Crypto. Secret redaction is in (PR #127): token formats, private keys, sensitive names and high-entropy values are masked with spans for click-to-reveal. The config file and Taskville home are in (PR #128): validated `config.json`, 0700 home, 0600 tokens, a safe session-opener template, and a 90 s default hold window pending decision #116. Batch 2 is complete. Event fixtures are in (PR #130): five JSONL fixtures with expected per-line ingest results and a shared loader. Engine storage is in (PR #134): an insert-only, gap-free event log enforced by SQLite triggers, projections with a rebuild helper, and owner-only database files. Attention, requests and commands are in (PR #137): one prompt, one red state; only bridge-held requests answerable; heuristic trouble from an injected clock. Retro tooling is in (PR #141): `pnpm retro M<n>` renders the milestone report from GitHub data with Mermaid charts and "not measured" where it cannot compute. The domain reducer is in (PR #139) and composed with attention and requests: replaying the same events gives the same `stateHash`, and the M1.17 fixtures replay to reviewed snapshots. Batch 3 is complete. The ingest pipeline is in (PR #145): per-event validation, masking before the content hash, duplicates and conflicts, and one transaction per batch with gap-free sequences proven under concurrent HTTP requests and three concurrent SQLite writers. The seeded six-agent demo producer is in (PR #146): calm, lively and custom paces, deterministic per seed and pace, offline and live modes. Snapshots and resumable SSE streams are in (PR #149): state plus cursor in one read, backlog then live with `Last-Event-ID`, heartbeats, resnapshot on slow consumers, and open requests expired at engine start. Batch 5 is complete. The CLI is in (PR #153): `serve --headless` with a printed one-time pairing URL, `project add/list`, `status` tree and `--json`, `events ingest/follow`, read-only `requests`, `unpair`. The demo commands are in (PR #156): `demo run --offline` prints a stable hash per seed and pace, and `demo start` posts the six-agent demo to a real `serve`. Batches 6 and 7 are complete apart from the remaining security fixes; batch 8 (performance and soak) is running. Remaining fixes for the security review (#17, [posted](https://github.com/jfvorwald/taskville/issues/17#issuecomment-6538400517): no critical or high; 3 medium, 3 low, each getting a fix PR).

## In progress

| Ticket | Lane | Teammate | State |
| --- | --- | --- | --- |
| [#103](https://github.com/jfvorwald/taskville/issues/103) M1.21 Performance and soak checks | Engine | storage | in progress |

Ready, waiting for a free teammate: none (storage teammate takes #103 after its security fixes). Blocked: #95 (retro) on #17 and #103.

## Done this wave

| Ticket | PR | roborev | Checks |
| --- | --- | --- | --- |
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

- [#113](https://github.com/jfvorwald/taskville/issues/113) persisted browser pairings are a same-user write path (default: persist digests per spec; alternative: memory only, re-pair after restart). Blocks nothing; the security review #17 weighs it, and it must be settled before `serve` wires pairings to storage.
- [#133](https://github.com/jfvorwald/taskville/issues/133) `node:sqlite` on pinned Node 26.8.2 has no `Database`/`Statement` names (default: alias `DatabaseSync`/`StatementSync` in `storage/sqlite.ts`; docs unchanged until approved). Blocks nothing.
- [#135](https://github.com/jfvorwald/taskville/issues/135) request merge and closure details (defaults: merge on exact tool name, the M2 adapter fills it on Notifications; close on the next same-session event from any agent; bridge record wins a merge). Blocks nothing in M1.
- [#138](https://github.com/jfvorwald/taskville/issues/138) tool-call count exactness and task graph shortcuts (defaults: bounded projection as specified; task graph literal, so `queued -> completed` is flagged). Blocks nothing.
- [#160](https://github.com/jfvorwald/taskville/issues/160) redactor strategy after six review rounds (default: keep patterns with robust boundaries; alternative: mask the rest of the line after any Authorization header or `-u` flag). Blocks nothing.
- [#163](https://github.com/jfvorwald/taskville/issues/163) getting a new pairing link after expiry (default: restart `serve`; window 10 minutes). Blocks nothing.
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
| `pnpm check` wall time (36 files, 768 tests) | 8.1 s | `time pnpm check` (macOS, Node 26.8.2) | #10 |
| Live `pnpm retro M1` | 7.2 s | `time pnpm retro M1` | #94 |
| `demo run --seed 42 --duration 2h --offline` (quickstart section 4) | same hash twice, 0.24 s | by hand, Node 26.8.2 | #18 |
| Offline 8-hour calm demo run | 127 ms | demo test suite (Node 26.8.2) | #14 |
| Ingest a 1,000-event batch (SC-004) | median 63.0 ms over 5 runs (56.9 to 88.0 ms), about 15,900 events/s | `pnpm --filter @taskville/engine run bench:ingest` (macOS, Node 26.8.2); reported, not gated | #13 |
| Replay 10,012 events / hash result | 51 ms / 5.9 ms (one run) | throwaway script, Node 26.8.2 | #9 |
| Hash a 759,588-byte state | about 9.6 ms (mean of 20 runs) | one-off script, not committed (Node 26.8.2) | #6 |
| Notification `permission_prompt` delay after PermissionRequest | 6.011 to 6.016 s (3 runs) | spike server log, Claude Code 2.1.312 | #3 |
| Terminal No to hook connection close | 15 ms (1 run) | spike server log | #3 |

Targets in the spec are not measurements until a ticket records them here with the command that produced them.

## Known follow-ups

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

Merge batch 2 as it lands; the M1 retro (#95) and the G1 summary once #17's fixes and #103 merge; #9, #10, #11, #12 once #5 and #6 merge. See [ROADMAP.md](ROADMAP.md).
