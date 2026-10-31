# Lessons learned

A running log, newest first. Anyone working on Taskville adds an entry when something surprises them: a wrong assumption, a failed approach, a flaky test, a review finding worth remembering, a tool quirk. Milestone retros in [retros/](retros/) summarize and link these.

Rules:

- One entry per lesson. Keep it short and specific enough that someone else would act differently next time.
- Never delete an entry. If a lesson turns out wrong, add a new entry that supersedes it and link back.
- Every entry has an **Action**: a change already made (link it), a ticket (link it), or "none, awareness only".

Entry format:

```markdown
### L-<number>: <one-line lesson>
- **Date:** YYYY-MM-DD · **Milestone:** M<n> · **Ticket:** #<issue> · **Recorded by:** <agent or person>
- **What happened:** <one or two sentences>
- **Lesson:** <what to do differently>
- **Action:** <link to change or ticket, or "none, awareness only">
```

## Entries

### L-40: Mask to a robust boundary instead of parsing ever more precisely
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #17 · **Recorded by:** hardening teammate (M1.18 F3)
- **What happened:** Fixing two reported credential forms took six roborev rounds and 18 more shapes (12 high findings in total, each fixed test-first); one finding (a space-led quoted Digest value) needed two fixes. Numeric-pair and path exemptions each hid a real password and were removed. A skip-ahead guard added for linear time hid nested input.
- **Lesson:** Masking to a robust boundary (line end, end of the shell word) closes whole classes; every exemption is bypass surface; skip ahead only inside regions already masked; assert exact output when the secret can equal visible text (`admin:admin`).
- **Action:** Fixed in PR #158; strategy question in decision ticket #160.

### L-39: Every parsed number that drives a loop or a clock needs a finiteness check
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #18 · **Recorded by:** domain teammate (M1.16)
- **What happened:** A digits-only regex accepted hundreds of 9s, which parse to `Infinity`; review found it three times, one flag at a time (`--duration` medium in job 4957, then custom pace intervals high and `--speed` medium in job 4962). Separately, macOS has no `timeout`, so a red run that could hang was not run, and its empty output was briefly misread as a reproduced hang.
- **Lesson:** Check `Number.isFinite` and an upper bound wherever input becomes a duration, interval or loop count, in the library and not only the CLI; write red tests against parser return values when the failing behavior is a hang.
- **Action:** Fixed in the CLI in PR #156; library parsers fixed in a follow-up PR (`M1.15-fix`).

### L-38: Engine-authored events built from user input skip ingest masking
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #16 · **Recorded by:** domain teammate (M1.14)
- **What happened:** `project.created` is written by the engine itself, so project names and roots from `project add` bypassed the ingest pipeline's masking and could carry secrets into the event log (roborev high, job 4918); a new project also had no projection (high, same job).
- **Lesson:** Any event the engine builds from user input needs its own validation and masking check; end-to-end goldens against the quickstart catch contract drift (here "active" vs `unknown` activity) that renderer unit tests miss.
- **Action:** Fixed in PR #153; cli.md's active rule clarified by the lead.

### L-37: CI tests the PR merged into current main
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #16 · **Recorded by:** domain teammate (M1.14)
- **What happened:** The first CI run on PR #153 failed typecheck on the merge ref because #152 merged meanwhile and made `bootEngine` require the pairing store; the branch's own `pnpm check` was green.
- **Lesson:** After main moves, merge it into the branch and re-check before trusting a green local run.
- **Action:** Fixed in PR #153; CI failure F-CI-1 recorded for the retro.

### L-36: A timeout for a stalled client must start at the cut-off, and check order is a safety property
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #17 · **Recorded by:** storage teammate (M1.18 fixes)
- **What happened:** A timeout started after the stream loop finishes never fires for a stalled client, because the loop itself is blocked writing to that client. In ingest, running the producer-policy check before the Unicode walk removed the only reachable path to unbounded nesting (F2).
- **Lesson:** Start timers at the event that should bound them; order validation so cheap policy checks reject before expensive walks, with a stack-overflow catch as the backstop.
- **Action:** Fixed in PR #152.

### L-35: Mutations that survive point at unreachable-in-normal-runs paths
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #15 · **Recorded by:** storage teammate (M1.13)
- **What happened:** Dropping duplicate frames, paging the backlog and the shutdown abort survived the done-when tests because those paths do not run in a normal stream. Separately, a post-commit roborev high (job 4899) found open requests were not expired at engine start.
- **Lesson:** After writing done-when tests, mutate each guard; a surviving mutation means a missing test that forces the rare path (republish an old batch, a 600-event backlog with nothing live).
- **Action:** Tests added and boot-time expiry implemented in PR #149.

### L-34: Hono stream close and writeSSE ordering can silently drop frames
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #15 · **Recorded by:** storage teammate (M1.13)
- **What happened:** Hono's `writeSSE` awaits before handing a frame to the writer, so `writeSSE` then an unawaited `close()` drops the frame (the error is swallowed); `close()` also sets a flag that makes a later client cancel skip `abort()`, so a cut-off stream stayed tracked until shutdown (roborev medium, job 4906).
- **Lesson:** Never close a stream while a write may still be blocked; use `stream.write(text)` when order matters, and let `streamSSE` close after the last write. Hono applies backpressure, which is what makes the bounded per-subscriber queue meaningful.
- **Action:** Fixed in PR #149.

### L-33: Same-session closure means a producer must hold the whole session
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #14 · **Recorded by:** domain teammate (M1.15)
- **What happened:** Requests close as `answered_elsewhere` on the next event from the same session, and subagents and in-process teammates share their parent's session (S-2), so they closed the demo's needs-you moment early. The review also found three identity gaps across repeated runs of one seed (core bots, transient agents and tasks, a run tag only to the second).
- **Lesson:** A producer that wants a request to stay open must quiet the whole session; decide repeated-run identity up front (stable core bots, per-run transient IDs, a millisecond run tag).
- **Action:** Done in PR #146; relates to decision #135 D2.

### L-32: Masking can make a field longer than its limit
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #13 · **Recorded by:** storage teammate (M1.12)
- **What happened:** A 6-character secret becomes a 20-plus character marker, so valid input could turn into an invalid stored envelope. Also, a credential-less POST without `Origin` is refused 403 by the Origin check before the 401 credential check, which broke a test expectation.
- **Lesson:** Cut every length-limited field again after masking. Tests for "no credential" must send an allowed `Origin`. Worker threads under Vitest can load `.ts` files, so real multi-connection SQLite concurrency tests are cheap.
- **Action:** Done in PR #145.

### L-31: Check producer text for lone surrogates before hashing it
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #13 · **Recorded by:** storage teammate (M1.12)
- **What happened:** JSON parsing and Zod accept lone surrogates, but canonical JSON refuses them, so one bad string crashed the content hash and failed the whole batch with a 500 (roborev medium, job 4872).
- **Lesson:** Validate well-formed UTF-16 per event before any hash, and reject only that event.
- **Action:** Fixed in PR #145 (abd0a38).

### L-30: Write the bounded-state contract before coding a bounded projection
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #9 · **Recorded by:** domain-hash teammate (M1.07)
- **What happened:** roborev raised the same bounded tool-call projection edge case three times (jobs 4828, 4831, 4838): a call dropped from the cap and then restarted is counted twice. Following the same-finding-twice rule, the third raise went to decision ticket #138 instead of a third fix.
- **Lesson:** Before coding bounded state, write down what is counted when and what is forgotten; it would have saved two review rounds.
- **Action:** Decision ticket #138 D1.

### L-29: Compare instants, not timestamp text, and never key reducer maps naively
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #9 · **Recorded by:** domain-hash teammate (M1.07)
- **What happened:** Under async hooks ingest order and occurrence order disagree, and protocol timestamps carry offsets and arbitrary fractional digits, so text comparison and `Date.parse` both mis-order. Producer IDs such as `constructor` or `__proto__` hit `Object.prototype` when read as `map[id]`.
- **Lesson:** Use the pure comparator in `reducer/entities/time.ts`; read maps with `Object.hasOwn` and write with computed spreads. The attention reducer still uses `Date.parse` for ordering.
- **Action:** Follow-up issue #143.

### L-28: Force-push is denied for teammates, and a quiet CI can mean a conflicted PR
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #9, #10 · **Recorded by:** lead
- **What happened:** Two teammates' `git push --force-with-lease` after a rebase was denied by the auto-mode permission check, so PR #139 kept a conflicted head and CI never ran on it. One teammate asked the lead three times to run the force-push instead; the lead declined (running it from another session would route around the permission decision) and had it record the old head with `git merge -s ours` and push normally. Both package.json files gaining the same dependency and `exports` entry made every rebase conflict.
- **Lesson:** After a PR exists, update by merging `origin/main` and pushing normally; check `mergeStateStatus` early, because CI does not run on a conflicted PR.
- **Action:** Teammate brief step 9 updated on 2026-10-30.

### L-27: Free-text review records are hard to measure honestly
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #94 · **Recorded by:** domain teammate (M1.19)
- **What happened:** The retro generator has to parse roborev outcomes out of task-report prose; every rule tightening came from a reviewer finding a phrasing that broke the previous rule, and M1.10 and M1.11 stay "not measured" because their reports omit severities. Per-day parallelism said 11 where at most 4 ran at once, because M1 so far fits in one UTC day.
- **Lesson:** Record review outcomes in a structured field, and count overlap at an instant, not presence in a bucket. Also: pnpm 12 rejects `pnpm -s`.
- **Action:** Proposed for the M1 retro: add a `**Review outcome:**` line to the docs/tasks/README.md format (the generator already reads it).

### L-26: Teammates must never edit the lead's main checkout
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #9 · **Recorded by:** lead
- **What happened:** After merging #141, `pnpm check` failed in the lead's main checkout on a typecheck error in `packages/domain/test/attention/requests.test.ts`. A clean checkout of the same commit passed: the file had an uncommitted 43-line edit made in the main checkout instead of a teammate worktree.
- **Lesson:** Verify merges in a clean checkout (or check `git status` first), and have teammates confirm their working directory before editing.
- **Action:** Patch saved and the owning teammate asked; the brief already says never to work in the main checkout.

### L-25: Merge rules that combine trusted and untrusted sources need a direction test
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #10 · **Recorded by:** domain-attn teammate (M1.08)
- **What happened:** Read literally, "the existing record is kept" on a merge would let a forged telemetry request that arrives before the bridge's supply the preview on an answerable card. roborev (job 4827, medium) also found that a succeeded `session.open` command counted as an answer.
- **Lesson:** When a trusted record (bridge) and an untrusted one (telemetry) merge, the trusted one wins regardless of order, with a test for each arrival order; only the specific answering command type counts as an answer.
- **Action:** Fixed in PR #137; decision ticket #135 D3.

### L-24: Never pick a record by map iteration order
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #10 · **Recorded by:** domain-attn teammate (M1.08)
- **What happened:** A projection restored from canonical JSON has sorted keys, and integer-like IDs ("3" before "20") reorder even in a live object, so "the first matching record" differed between live and restored state.
- **Lesson:** Choose by explicit fields (here `openedAt`, then ID) and pin it with a canonical-JSON round-trip test.
- **Action:** Done in PR #137.

### L-23: SQLite triggers alone need care to make a table insert-only
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #11 · **Recorded by:** storage teammate (M1.09)
- **What happened:** `INSERT OR REPLACE` deletes the conflicting row without firing DELETE triggers (unless `recursive_triggers` is on), and SQLite fired a later-created BEFORE INSERT trigger first, so ordered checks split across triggers misbehaved. SQLite creates `-wal` and `-shm` with the database file's mode bits.
- **Lesson:** Put ordered checks in one trigger body as `SELECT RAISE(...) WHERE ...`, block REPLACE explicitly, and create the database file 0600 before opening it.
- **Action:** Done in PR #134.

### L-22: Verify "use the new API names" against the pinned runtime
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #11 · **Recorded by:** storage teammate (M1.09)
- **What happened:** ARCHITECTURE.md, research.md, plan.md and data-model.md all say to use `Database` and `Statement` from `node:sqlite`, but the pinned Node 26.8.2 exports only `DatabaseSync` and `StatementSync`.
- **Lesson:** Check an API-name claim with `Object.keys(require("node:sqlite"))` on the pinned Node before building on it.
- **Action:** `storage/sqlite.ts` aliases the classes in one place; decision ticket #133 for the docs fix.

### L-21: A golden file needs something independent that reproduces it
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #12 · **Recorded by:** domain teammate (M1.17)
- **What happened:** Expected ingest results were hand-written per fixture line. On their own they would only restate the author's assumptions.
- **Lesson:** Check a golden file with an independent model (here a small reference ingest model over the protocol's parsers) and prove the comparison bites with a deliberate mutation. Design fixtures backwards from documented output when the docs already fix it.
- **Action:** Done in PR #130.

### L-20: An argv array is not enough to make a configurable launcher safe
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #8 · **Recorded by:** engine teammate (M1.11)
- **What happened:** A session opener validated only as an `execFile` argument array could still name `sh`, `env`, `osascript` or `python3` as the program, which turns an argument back into code. Separately, `mkdirSync({ mode: 0o700 })` is filtered by the umask and leaves an existing directory alone, and roborev (job 4776) found that tightening a symlinked home would chmod the link target.
- **Lesson:** Refuse shells, launchers and interpreters as the program and never let a placeholder pick it; tighten existing directories with an explicit `chmod` after an `lstat` that refuses symlinks.
- **Action:** Fixed in PR #128.

### L-19: Wall-time bounds in tests should separate linear from quadratic, not measure speed
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #24 · **Recorded by:** adapter teammate (M1.20)
- **What happened:** Flake F-1: adversarial redaction timing tests with a 250 ms bound took 260 and 285 ms with 21 test files running in parallel under `pnpm check`, and 18 to 19 ms alone. The real regression they exist to catch was a quadratic scan that took 55 s.
- **Lesson:** Set timing bounds in seconds (here 2,000 ms) so they catch complexity regressions, never machine load.
- **Action:** Bound raised in PR #127.

### L-18: Rebuilding objects from untrusted JSON must not assign `__proto__`
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #24 · **Recorded by:** adapter teammate (M1.20)
- **What happened:** Plain assignment of a parsed `__proto__` key changes the prototype of the rebuilt object, and the JSON walker lost property-name context inside arrays until it carried it down.
- **Lesson:** Use `Object.defineProperty` (or null-prototype objects) when rebuilding untrusted JSON, and carry the parent key through arrays.
- **Action:** Fixed in PR #127.

### L-17: A redactor's skip rules are bypass surface
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #24 · **Recorded by:** adapter teammate (M1.20)
- **What happened:** Every "this is a placeholder" exemption (`$` prefix, marker prefix, path-like runs) drew a roborev high finding until it was exact: 2 high and 1 medium in the first panel, 3 new highs in the re-review, and 2 highs in a post-commit review that were regressions from an earlier fix.
- **Lesson:** An exemption must match one complete reference or marker spanning the whole value. Land each fix with its failing test first, since fixes to a redactor regress easily.
- **Action:** Fixed in PR #127; the security review (#17) includes the redaction path at ingest.

### L-16: Grep Unicode tests for literal non-ASCII after writing them
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #6 · **Recorded by:** domain-hash teammate (M1.06)
- **What happened:** The agent file-write tool saved `\uXXXX` escapes as the literal characters, including invisible U+FFFF and U+2028. Tests still passed, so it was nearly missed; it was caught in a diff. Separately, TypeScript 7 only accepts `Uint8Array<ArrayBuffer>` for `crypto.subtle.digest`.
- **Lesson:** After writing tests with Unicode escapes, grep the file for non-ASCII bytes and rewrite escapes with a script if needed.
- **Action:** Fixed in PR #124.

### L-15: Zod refinements and field transforms do not survive schema export
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #5 · **Recorded by:** domain teammate (M1.05)
- **What happened:** Keeping a raw enum value as a sibling `sourceValue` needed an object-level transform (a field-level transform loses it), and per-type requirements in `superRefine` do not reach `z.toJSONSchema`, so the exported documents showed required IDs as optional (a roborev low finding).
- **Lesson:** Keep stored schemas transform-free (split input and stored payload maps) and add refinement-only requirements to exported JSON Schema by hand, with a test.
- **Action:** Done in PR #123.

### L-14: A synchronous open of an untrusted path can hang the test worker
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #7 · **Recorded by:** engine teammate (M1.10)
- **What happened:** `openSync` on a FIFO at the token path blocked the whole Vitest worker, so the per-test timeout never fired and the red run had to be killed by hand. roborev also flagged the FIFO hang in the code.
- **Lesson:** Open untrusted paths with `O_NONBLOCK` and `fstat` before reading; refuse anything that is not a regular file.
- **Action:** Fixed in PR #119 (d292fe9).

### L-13: Read the Host header, not the request URL, for the Host check
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #7 · **Recorded by:** engine teammate (M1.10)
- **What happened:** `@hono/node-server` fills the request URL from its own `hostname` option when a request has no Host header, so a URL-based check would pass a missing Host.
- **Lesson:** Check the raw Host header. Register security middleware with `app.use()` in `createApp` so routes added later inherit it (a test proves it). Never mint pairing codes over HTTP, even behind the CLI token, since agents can read that token.
- **Action:** Done in PR #119.

### L-12: Re-read the contracts after every rebase
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #7 · **Recorded by:** engine teammate (M1.10)
- **What happened:** M1.01 merged new route names, error codes, a 501 commands stub and persistent pairings while M1.10 was being built to the old contract, and the #7 issue still says "node:http router" in its first bullet.
- **Lesson:** Re-read the contract files after each rebase and before review, not only at the start; follow the revision 3 bullet over older wording in a ticket.
- **Action:** none, awareness only.

### L-11: Interactive spike sessions still touch user-level state
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #3, #4 · **Recorded by:** lead
- **What happened:** Running interactive Claude Code sessions in throwaway folders required accepting the folder trust dialog, which added one project entry per spike folder to `~/.claude.json`. One S-2 session ran with default setting sources, so the owner's user-level hooks and plugins fired once for a scratch session. Nothing under `~/.claude/` was edited.
- **Lesson:** "Project-scoped settings only" does not keep a spike out of user state. Spikes should pass `--setting-sources project,local` (or `--settings` alone) on every run, and the plan should say up front that trust-dialog entries will be added, so the owner can approve or clean them.
- **Action:** Reported to the owner at the end of the wave; entries left in place pending the owner's call. Future spike briefs will require explicit setting sources.

### L-10: Split-pane teammates are invisible to the permission bridge
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #4 · **Recorded by:** research-s2 teammate (M1.04)
- **What happened:** In split-pane mode a teammate's permission prompt fires no PermissionRequest hook; the lead only gets a `worker_permission_prompt` Notification. In-process teammates share the lead's `session_id` and are identified by `agent_id`. A roborev high finding caught an unlabelled heuristic parent link in the first draft.
- **Lesson:** Teammate attribution depends on display mode; anything inferred (parent links before `PostToolUse(Agent).tool_response.agentId`, names from notification text) must be labelled heuristic.
- **Action:** Decision ticket #120 for the owner at G1; fixed in PR #118.

### L-9: Spikes that drive Claude Code must set the permission mode and split tmux input
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #3 · **Recorded by:** research-s1 teammate (M1.03)
- **What happened:** An unflagged nested session started in auto mode (the owner's default), and long text plus Enter in one `tmux send-keys` sometimes left the prompt unsubmitted.
- **Lesson:** Pass `--permission-mode default` explicitly, and send text and `C-m` as separate `send-keys` calls.
- **Action:** none, awareness only.

### L-8: Reaching an open hook response does not prove a permission decision took effect
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #3 · **Recorded by:** research-s1 teammate (M1.03)
- **What happened:** The terminal prompt stays answerable while the PermissionRequest hook holds. A terminal Yes leaves the hook request open until timeout and a later hook answer is written successfully but ignored; a terminal No closes the connection within 15 ms and fires no other hook.
- **Lesson:** The bridge must treat city decisions as unconfirmed until telemetry confirms them, and read a closed connection as a terminal No. The focus-dependent short hold in ARCHITECTURE.md 8.1 is not needed.
- **Action:** Decision ticket #116 (hold window and terminal-answer rules) for the owner at G1.

### L-7: A docs alignment ticket that feeds code tickets makes contract decisions
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #1 · **Recorded by:** docs teammate (M1.01)
- **What happened:** Aligning spec 001 meant choosing engine-only event types, a reserved source prefix, and the project registry. roborev found two high findings (dedupe hash taken after truncation; masking scope too narrow) and one medium (request merge key missing the agent) that wording-level review would have missed.
- **Lesson:** Review a contract-alignment docs PR as a design change, and route any choice the architecture does not make to a decision ticket.
- **Action:** Fixed in PR #112; open choices in decision tickets #110 and #114.

### L-6: Vitest 5 configures projects in vitest.config.ts, not a workspace file
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #2 · **Recorded by:** infra teammate (M1.02)
- **What happened:** The plan named `vitest.workspace.ts`, which Vitest 5 no longer uses.
- **Lesson:** Configure test projects under `test.projects` in the root `vitest.config.ts`.
- **Action:** Done in PR #108.

### L-5: pnpm 12 swallows reporter flags meant for Vitest
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #2 · **Recorded by:** infra teammate (M1.02)
- **What happened:** pnpm 12 claims `--reporter`, and `pnpm test -- <flags>` forwards a literal `--` after which Vitest ignores flags.
- **Lesson:** Call `node_modules/.bin/vitest` directly when you need Vitest flags.
- **Action:** none, awareness only.

### L-4: Biome 2.6 formats Markdown, so scope it to code
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #2 · **Recorded by:** infra teammate (M1.02)
- **What happened:** An unscoped `biome check .` failed on the spec-kit skill files.
- **Lesson:** Keep `files.includes` limited to TS, JS and JSON, excluding `.claude/` and `.specify/`.
- **Action:** Done in PR #108 (`biome.json`).

### L-3: Check migrated Biome config by hand
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #2 · **Recorded by:** infra teammate (M1.02)
- **What happened:** `biome migrate --write` on Biome 2.6.4 rewrote `"recommended": true` to `"preset": "none"`, silently disabling every recommended lint rule.
- **Lesson:** After any config migration, diff the result and confirm the rules you expect are still on.
- **Action:** `"preset": "recommended"` set in PR #108.

### L-1: Check the tool's install root before running workflow commands
- **Date:** 2026-10-30 · **Milestone:** planning · **Ticket:** none · **Recorded by:** Claude (planning session)
- **What happened:** Spec Kit had been initialized one directory below the Git root, so its scripts treated `taskville/taskville` as the project root while the architecture placed code at the Git root.
- **Lesson:** Before running a tool's workflow commands, confirm where the tool was initialized and that it matches where the code will live.
- **Action:** `.specify/`, `.claude/skills/` and `specs/` were moved to the Git root on 2026-10-30.

### L-2: Run an independent review before calling a design final
- **Date:** 2026-10-30 · **Milestone:** planning · **Ticket:** none · **Recorded by:** Claude (planning session)
- **What happened:** An independent review of architecture revision 2 found three high-severity gaps: an agent could have approved its own permission prompt with the CLI token, the action card could have hidden part of the input being approved, and needs-you was per project only.
- **Lesson:** Have the security-sensitive parts of a design (anything that grants permission or runs commands) reviewed by someone who did not write them before tickets are cut.
- **Action:** Fixed in ARCHITECTURE.md sections 2.4, 2.8, 9.2 and 13; every milestone that touches auth or commands has a security review ticket.
