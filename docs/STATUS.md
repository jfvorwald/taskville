# Status

Lead-owned cross-session summary. Teammates write their own reports in [tasks/](tasks/).

**Updated:** 2026-11-02 00:00 UTC. **Main:** 33baf17. **State:** M4 complete to G4 #75, still open awaiting human review. M5/M6 remain in progress under the owner authorization. M5.02 feature branch contains child PR322; this is not main or milestone acceptance.

## Done in M4 Stuck and interaction (awaiting owner review at G4)

Gate summary: [G4 #75](https://github.com/jfvorwald/taskville/issues/75). Retro: [retros/M4.md](retros/M4.md). Lessons L-182 to L-195.

| Ticket | PR | Outcome |
| --- | --- | --- |
| M4.08 #49 session opener | #273 | [report](tasks/M4.08.md) |
| M4.05 #53 stuck visuals | #274, clip #316 | fps of stuck agents unmeasured (#268 open); [report](tasks/M4.05.md) |
| M4.02 #51 permission bridge | #275 | decision #271 defaults in force; [report](tasks/M4.02.md) |
| M4.12 #272 flaky shim test | #276 | orchestrator port probes; [report](tasks/M4.12.md) |
| M4.06 #54 quip and emote bubbles | #277 | [report](tasks/M4.06.md) |
| M4.01 #50 global attention feed | #278 | interim Back to Unsorted; [report](tasks/M4.01.md) |
| M4.03 #52 command service | #280 | known limitations in the report; [report](tasks/M4.03.md) |
| M4.09 #55 soundscape | #287 | [report](tasks/M4.09.md) |
| M4.04 #61 bridge and command wiring, installer hook | #288 | decision #284 defaults applied; [report](tasks/M4.04.md) |
| M4.07 #62 action card | #294 | [report](tasks/M4.07.md) |
| M4.16 #302 opener retry key | #304 | [report](tasks/M4.16.md) |
| M4.15 #293 hidden characters, reload reset | #305 | [report](tasks/M4.15.md) |
| M4.14 #290 header count from the global feed | #297 | [report](tasks/M4.14.md) |
| M4.13 #286 audio parking after failed loads | #299 | [report](tasks/M4.13.md) |
| M4.10 #69 permission e2e | #308 | replay 6/6; live run NOT RUN pending #289 (issue open); [report](tasks/M4.10.md) |
| M4.11 #70 security review | review on #70 | fixes in #309 (M4.17, #310); H1 rests on #198 |
| M4.17 #309 security review fixes | #310 | [report](tasks/M4.17.md) |

Wave run on main (a7d2d01): `pnpm check` 4,179 of 4,179; browser 335 of 345 with 10 load flakes (all 8 files passed alone); app e2e, permission replay and telemetry replay pass; web smoke theme switch failed twice: Settings unreachable while an agent is selected (#315, from the M5.07 sidebar composition).

## In progress: M5 Crews and code feed and M6 History

- Merged on main: M5.01 #56 (#291), M5.03 #58 (#301), M5.05 #59 (#292), M5.06 #64 (#307), M5.07 #65 (#303), M5.16 #296 (#298), M6.01 #60 (#282), M6.02 #68 (#300), M6.03 #73 (#306). Live GitHub states for #307/#306 verified during this integration.
- M5.02 #57: parent PR321 remains draft. Child PR322 merged normally into M5.02 at5df1f07, with exact source/test equality to reviewed fcc7638. Final source gate4,259 and web1,434 pass; focused lifecycle browser14 pass. Broader browser51 pass/1frame-wait failure, unchanged isolated file1pass. Panel6532 and independent source reviews pass. Required 45.92-second seed7 demo clip recorded with99accepted events/two subagents and two finishes; final parent panel6535 and exact head67c41c9 CI PASS. Normal main merge refused by base policy;#295 blocks#57/#314. Parent main integration is not accepted.
- Open roadmap work, verified from GitHub: M5.04 #63, M5.08 #66, M5.09 #71, M5.10 #67, M5.11 #72, M5.12 #104, M5.13 #175; M6.04 #77, M6.05 #78, M6.06 #74, M6.07 #79; retros #99/#100 and owner gates #76/#80. Open follow-ups #279, #281, #285, #311, #312 and #318 remain.
- Reviewed branches M5.02 #57/PR321, M5.17 #313/PR320 and M5.19 #315/PR319 were blocked by normal main merge policy; #295 remains open. M5.18 #314 source is integrated into the parent feature branch; its issue remains open until the main stack integrates. No admin bypass or repository configuration change was used.
- Performance: the M3 budget shortfall (#268) stays open and unmet; lively-day seeks miss 300 ms (#279).

## Done in wave 2 (M3 Live city)

Gate summary: [G3 #48](https://github.com/jfvorwald/taskville/issues/48). Retro: [retros/M3.md](retros/M3.md). Lessons L-118 to L-181. Merged as a chain of merge-commit PRs (lead/m3 merge chain; no force pushes).

| Ticket | PR | Outcome |
| --- | --- | --- |
| M3.01 #26 web scaffold, engine static hosting, pairing page | #229 | [report](tasks/M3.01.md) |
| M3.02 #30 client data layer | #238 | sync abort race fixed in M3.23; [report](tasks/M3.02.md) |
| M3.03 #31 overlay host and anchors | #239 | [report](tasks/M3.03.md) |
| M3.04 #32 city layout and buildings | #240 | instanced meshes on theme switch fixed in M3.24; [report](tasks/M3.04.md) |
| M3.05 #33 block agents | #241 | [report](tasks/M3.05.md) |
| M3.07 #37 theme system and cyberpunk | #242 | [report](tasks/M3.07.md) |
| M3.06 #36 navigation state machine | #243 | [report](tasks/M3.06.md) |
| M3.18 #232 navigator queue flag | #244 | [report](tasks/M3.18.md) |
| M3.11 #38 camera, selection, glow, fade | #245 | [report](tasks/M3.11.md) |
| M3.12 #44 day and night lighting | #246 | [report](tasks/M3.12.md) |
| M3.15 #39 settings panel | #247 | [report](tasks/M3.15.md) |
| M3.08 #41, M3.09 #42, M3.10 #43 themes | #248, #249, #250 | reports [08](tasks/M3.08.md), [09](tasks/M3.09.md), [10](tasks/M3.10.md) |
| M3.17 #230 cross-ticket wiring | #251 | no task report |
| lead: @axe-core/playwright | #252 | dependency for M3.14 |
| lead: e2e one engine per spec | #255 | harness |
| M3.13 #45 celebrations | #253 | [report](tasks/M3.13.md) |
| M3.14 #46 accessibility and comfort | #254 | [report](tasks/M3.14.md) |
| M3.20 #234 emissive level | #259 | [report](tasks/M3.20.md) |
| M3.22 #237 reduced motion wiring | #260 | [report](tasks/M3.22.md) |
| M3.19 #233 test hooks behind a build flag | #261 | [report](tasks/M3.19.md) |
| M3.21 #235 token contrast | #262 | [report](tasks/M3.21.md) |
| M3.23 #256 data and overlay review fixes | #264 | [report](tasks/M3.23.md) |
| M3.25 #258 settings and wiring review fixes | #265 | [report](tasks/M3.25.md) |
| M3.24 #257 city rendering review fixes | #266 | [report](tasks/M3.24.md) |
| M3.26 #263 flaky browser tests | #267 | [report](tasks/M3.26.md) |
| M3.16 #47 performance budget and smoke | #269 | below budget, #268; [report](tasks/M3.16.md) |

## Done in wave 2 (M2)

Gate summary: [G2 #40](https://github.com/jfvorwald/taskville/issues/40). Retro: [retros/M2.md](retros/M2.md). Lessons L-45 to L-117.

| Ticket | PR | Outcome |
| --- | --- | --- |
| M2.01 #20 hook shim with spool | #186 | fixed or answered; [report](tasks/M2.01.md) |
| M2.02 #21 source endpoint | #179, #181 | [report](tasks/M2.02.md) |
| M2.03 #22 adapter: sessions, tools, notifications | #182 | [report](tasks/M2.03.md) |
| M2.04 #23 adapter: subagents and teams | #180 | [report](tasks/M2.04.md) |
| M2.06 #27 evidence store | #189 | [report](tasks/M2.06.md) |
| M2.07 #28 spool ingest, late semantics | #191, #196 | [report](tasks/M2.07.md) |
| M2.08 #29 install and uninstall | #195 | [report](tasks/M2.08.md) |
| M2.09 #25 live Git watcher | #192 | [report](tasks/M2.09.md) |
| M2.10 #34 real-session e2e | #208 | replay 7/7, 0 todo; [report](tasks/M2.10.md) |
| M2.11 #35 security review | #205; fixes #218, #219, #220 | 3 medium fixed; F4 #214 and F5 #215 retained; [report](tasks/M2.11.md) |
| M2.12 #173 pairing link, persisted pairings | #199 | [report](tasks/M2.12.md) |
| M2.13 #183 reducer rules for real sessions | #197 | [report](tasks/M2.13.md) |
| M2.14 #185 redactor GitHub tokens | #188 | [report](tasks/M2.14.md) |
| M2.15 #143 attention ordering | #201 | [report](tasks/M2.15.md) |
| M2.16 #167 bounded projection state | #204 | [report](tasks/M2.16.md) |
| M2.17 #194 redactor nested values | #200 | [report](tasks/M2.17.md) |
| M2.18 #166 projection cache, SQLite limits | #203 | SC-006 still MISSED; [report](tasks/M2.18.md) |
| M2.19 #207 CLI retired counts | #221 | [report](tasks/M2.19.md) |
| M2.20 #209 crew mapper team task | #217 | 8-hex scope trade-off accepted; [report](tasks/M2.20.md) |
| M2.21 #210 Git lazy fetch (F1) | #218 | [report](tasks/M2.21.md) |
| M2.22 #211 redaction gaps (F2) | #219 | 4 crafted gaps pre-existing on main: #222 (decision #223 closed on default); [report](tasks/M2.22.md) |
| M2.23 #212 private home (F3) | #220 | [report](tasks/M2.23.md) |
| M2.RT #96 retro | #224 | [report](tasks/M2.RT.md) |

Wave verification on main 44f5af1 with no workers running: `pnpm check` 94 files, 2,275 tests; real-session replay 7/7; `pnpm perf:unit` 14; SC-004 and SC-005 PASS (see Measurements). Flake F-2 (M2.10 replay under load). Recovery audit: [RECOVERY-2026-10-31](tasks/RECOVERY-2026-10-31.md).

Workers this session (all stopped after handoff, branches frozen, worktrees kept): Claude Sonnet 5.5 medium for M2.20, M2.10 completion, M2.19; Sonnet 5.5 high for M2.21, M2.22, M2.23; Haiku 5.5 low for the lessons copy. The live usage display could not be read from the lead session; work ended well inside the provisional 19:50 EDT cutoff.

## Remaining decisions

Open owner decision issues: #178, #190, #198. Defaults remain in force; none blocks M3. Closed on the owner's "accept defaults" on 2026-10-31 19:02 EDT: #174, #176 (D2 applied: constitution 1.3.0 allows roadmap tickets with explicit contracts per milestone; M3 Constitution Check runs in its retro), #184, #187, #202, #206. Earlier: #213 (CLI token keeps root registration; residual risk in the G2 summary) and #223 (#219 merged; targeted linear rules, #222 after G2).

SC-006 remains MISSED (valid figure 39.7%, not a quiet machine; 28.7% and M2.16's overlap invalid). The 1x eight-hour run remains M7 work.

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

- G4 [#75](https://github.com/jfvorwald/taskville/issues/75): the M4 gate review.
- [#198](https://github.com/jfvorwald/taskville/issues/198): sessions not minted by the run the human started can now approve prompts (M4.11 H1); default accept and document in force.
- [#289](https://github.com/jfvorwald/taskville/issues/289): live permission e2e writes `~/.claude.json`; NOT RUN meanwhile.
- [#284](https://github.com/jfvorwald/taskville/issues/284): bridge hook port-squatting residual; defaults applied.
- [#271](https://github.com/jfvorwald/taskville/issues/271): permission request fall-through stays open and unanswerable (default in force).
- [#236](https://github.com/jfvorwald/taskville/issues/236): theme mockup fidelity (defaults block nothing).
- [#178](https://github.com/jfvorwald/taskville/issues/178), [#190](https://github.com/jfvorwald/taskville/issues/190), [#198](https://github.com/jfvorwald/taskville/issues/198): engine, protocol and installer decisions on their defaults.

Items there are blocking only if the ticket says so; everything else proceeds on its stated default.

## Measurements

| What | Value | Command | Ticket |
| --- | --- | --- | --- |
| Web city, six demo agents moving / idle (M3.16) | 33.5 fps (target 60, MISS) / 21.0 fps (target 20); idle browser CPU 11.3% of one core (target under 5%, MISS) | `node tests/e2e/web/measure.ts --headed` on main 4490436 code, real GPU, no workers (a roborev job running) | #47, #268 |
| `.claude/check.sh` wall time, clean clone | 0.72 s | `time ./.claude/check.sh` (macOS, Node 26.8.2, pnpm 12.4.2) | #2 |
| Redaction, adversarial 100,000-char inputs | at most 27 ms each alone (23 inputs); up to 285 ms under parallel `pnpm check` | adapters test suite | #24 |
| `pnpm check` wall time (36 files, 768 tests) | 8.1 s | `time pnpm check` (macOS, Node 26.8.2) | #10 |
| Live `pnpm retro M1` | 7.2 s | `time pnpm retro M1` | #94 |
| `demo run --seed 42 --duration 2h --offline` (quickstart section 4) | same hash twice, 0.24 s | by hand, Node 26.8.2 | #18 |
| Offline 8-hour calm demo run | 127 ms | demo test suite (Node 26.8.2) | #14 |
| SC-004 batch over HTTP to real `serve`, M2 wave | p50 92.8 ms, max 99.5 ms (5 runs): PASS | `pnpm perf batch` on main 44f5af1, no workers running (Apple M1, Node 26.8.2) | #96 |
| SC-005 ingest to SSE viewer, M2 wave | idle max 12.2 ms, with demo max 10.2 ms (1,000 probes each): PASS | `pnpm perf latency` on main 44f5af1 | #96 |
| SC-006 calm soak after #203 | 39.7% MISS (98.9 to 138.2 MiB); 28.7% rerun invalid (overlapped another soak) | `pnpm perf soak` | #166, #206 |
| Real-session replay | 7 pass, 0 todo (19.5 s) | `node --test tests/e2e/claude-code-telemetry/` | #34 |
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

M4 to its wave run, retro and the G4 summary on #75 (left open for owner review), then M5 and M6 under the same authorization. Still to schedule: #268 (web performance), #236 (theme fidelity), and the post-G3 follow-ups #214, #215, #222 and the browser-test follow-ups in the M3.26 report. The next milestone runs in T3 Code with Claude subagents as the orchestration experiment's comparison run (#231); M3's baseline snapshot is linked from the G3 summary.
