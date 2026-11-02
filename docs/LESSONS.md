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

### L-202: Scope decisions do not substitute for source review
- **Date:** 2026-11-01 · **Milestone:** M6 · **Ticket:** #78 · **Recorded by:** CTO (Sol)
- **What happened:** The owner accepted producer-limited task-history entry after the missing Claude Code attribution was identified. The existing branch still had historical failed review results.
- **Lesson:** Apply the owner decision to scope and tracking, then finish the remaining checks and confirmation on the actual source. Do not relabel an old failed review or infer code approval.
- **Action:** #325 closed, #78 returned to Review, PR326 final checks/reviews handed to Claude. This updates the current disposition in L-201 without removing its provenance lesson.

### L-201: Recorded UI success does not establish producer support
- **Date:** 2026-11-01 · **Milestone:** M6 · **Ticket:** #78 · **Recorded by:** CTO (Sol)
- **What happened:** A valid synthetic activity carried a task ID, while current Claude Code activity mapping does not. The UI worked for that fixture but remained unavailable for the primary source.
- **Lesson:** Check producer-to-domain provenance before claiming acceptance; missing relationships must stay unknown rather than guessed.
- **Action:** #325 D3 and #78 hold full acceptance. PR326 preserves the explicit-task path and missing-creation handling; adapter scope has not been expanded silently.

### L-200: Commit presentation baselines with successful state changes
- **Date:** 2026-11-01 · **Milestone:** M6 · **Ticket:** #74 · **Recorded by:** CTO (Sol)
- **What happened:** A failed seek seeded effect history from an undisplayed target; an older seek completion could also clear a newer seek's suppression.
- **Lesson:** Keep the displayed baseline until the read succeeds and fence each seek independently. Exercise actual renderer output on failed and overlapping reads.
- **Action:** PR327 source97fe8a8 adds both regressions, atomic baseline publication and per-seek tokens; panel6576 and independent reviews PASS. Main integration awaits #295.

### L-199: Ambient controls must account for changing host height
- **Date:** 2026-11-01 · **Milestone:** M6 · **Ticket:** #77 · **Recorded by:** CTO (Sol)
- **What happened:** An isolated Back to live test missed the existing header. A fixed offset cleared the default header but failed after global project chips wrapped.
- **Lesson:** Test the real host with changing content, including actual click reachability; position dependent controls from the rendered host bounds.
- **Action:** PR324 adds full SceneRoot default/wrapped-header and single-audio-connection coverage. Source dacc4a1, panel6549 and specialist reviews pass; main integration awaits #295.

### L-198: Current owner instructions govern restricted merges
- **Date:** 2026-11-01 · **Milestone:** M5 · **Ticket:** #295 · **Recorded by:** CTO (Sol)
- **What happened:** L-194 records an earlier assistant's claim about a standing admin-bypass order. The current owner authorization explicitly says to record enforced merge restrictions and continue independent work.
- **Lesson:** An older assistant-authored claim does not override the current owner instruction. Record normal merge refusals and use only currently authorized paths. This supplements L-194 for the present run.
- **Action:** #295 remains open for blocked main merges. PR322 used a normal merge into M5.02; no protection/configuration changes or admin bypass.

### L-197: Review approval follows the exact source tree
- **Date:** 2026-11-01 · **Milestone:** M5 · **Ticket:** #314 · **Recorded by:** CTO (Sol)
- **What happened:** Independent source reviews passed while a later required panel still found a collapsed-completion lifecycle gap. Older-head CI notifications also arrived after source corrections.
- **Lesson:** Preserve every concrete finding until code and regressions resolve it. Associate approvals and CI with exact commits, and recheck substantive follow-ups.
- **Action:** PR322 records source fcc7638, panel6532, bounded specialist rechecks and exact final-head CI. Broader browser timing failure and isolated retry remain reported.

### L-196: Accessible rows must follow represented lifecycle
- **Date:** 2026-11-01 · **Milestone:** M5 · **Ticket:** #314 · **Recorded by:** CTO (Sol)
- **What happened:** A finished bot stayed represented by a crew marker while premature anchor removal dropped its keyboard row. Cached attention also left closed requests labeled Needs you.
- **Lesson:** Retain the actual agent's marker and accessible row until its tracked return/fade ends, while deriving status from current attention.
- **Action:** Fixed and regression-tested in PR322, merged into parent M5.02. Issue#314 remains open pending main integration.

### L-195: Under a heavily loaded machine, browser suites flake in bulk
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #75 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** The M4 wave run had 10 browser failures across 8 files; every file passed alone. Engine memory, watcher and state tests also timed out at 5 s twice each during ticket checks.
- **Lesson:** Run the wave suite when workers are idle; a third timeout of the same test gets a fix or quarantine ticket.
- **Action:** Recorded in the M4 retro.

### L-194: A merge policy rule is not a blocker when the owner has named the path
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #295 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** While Claude was rate limited, a Codex session treated ruleset 26292102 as a blocker and held 10 ready PRs; the owner's standing order is to merge with gh pr merge --admin through that ruleset's admin bypass.
- **Lesson:** Check the owner's standing orders (memory) before opening a decision ticket about merging.
- **Action:** Resolved on #295; 10 PRs merged at 15:05 EST.

### L-193: biome format rewrites \u escapes into invisible literal characters
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #309 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** Formatting test files with \u escapes for invisible characters turned them into literal characters; another hand edit then broke line length and CI.
- **Lesson:** Run biome format, then restore escapes, then run biome check on the file before committing.
- **Action:** Awareness; seen in M4.07 and M4.17.

### L-192: CI's pnpm minimumReleaseAge rejects same-day dependency releases
- **Date:** 2026-11-01 · **Milestone:** M5 · **Ticket:** #64 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** @tanstack/react-virtual 3.14.25 (published the same day) failed --frozen-lockfile in CI.
- **Lesson:** Pin to a release older than the policy window; never add exclusions to pass CI.
- **Action:** Pinned 3.14.24 in M5.06.

### L-191: A live permission e2e writes user config through the folder-trust dialog
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #289 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** An interactive claude session in a new folder writes a trust entry into ~/.claude.json.
- **Lesson:** Treat live Claude Code e2e runs as user-config changes; build a replay e2e first.
- **Action:** Decision #289; replay e2e merged in #308.

### L-190: Two failed fix rounds on the same timing bug means the debugger, not a third guess
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #55 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** M4.09's cue-versus-suspend bug survived two implementer rounds; the Opus debugger replaced two park paths with one deadline in one round.
- **Lesson:** Hand timing and virtualization bugs to the debugger after the second failed round.
- **Action:** Applied in M4.09 and M5.06.

### L-189: roborev keeps finding new valid issues each round; stop with pins, not more rounds
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #52 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** M4.03 saw new findings on 7 panel rounds; M4.09 and M5.06 behaved the same.
- **Lesson:** After one review and one confirm round, defer remaining non-critical findings to follow-up tickets with a red-test contract.
- **Action:** Follow-ups #285, #286, #293, #313, #314, #311, #312.

### L-188: Rebuttals that contradict the architecture's literal text go to the lead
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #52 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** An implementer's rebuttal on M4.03 (session.open needs only a recorded request) survived one roborev round and returned as high.
- **Lesson:** Implementers escalate disputes with ARCHITECTURE.md to the CTO instead of answering them with roborev respond.
- **Action:** Applied from M4.03 on.

### L-187: Copy-paste text is an execution surface
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #309 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** The action card's Open session copy-only text carried a recorded cwd into a terminal paste; a cwd with ';' ran a second command.
- **Lesson:** Single-quote every value in text meant for a shell paste; keep display marking and copy stripping as separate character sets.
- **Action:** Fixed in M4.17 (#310).

### L-186: Re-surface owner decisions deferred 'until M4' when M4 lands
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #198 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** M4.11's cross-ticket review found that #198's latent same-user session path became live once browser sessions got the command scope; per-ticket reviews had not flagged it.
- **Lesson:** At a milestone's security review, list every open decision whose default was 'safe until this milestone' and re-ask.
- **Action:** Flagged at the top of the G4 summary; note on #198.

### L-185: The orchestrator can perturb local-port tests
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #272 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** The shim test flake was T3 Code probing every new local listening port with GET / about every 3 s; the stand-in servers counted those probes.
- **Lesson:** Count only the client under test (e.g. curl requests) in local-port harnesses.
- **Action:** Fixed in M4.12 (#276).

### L-184: T3 delegate_task children do not load the owner's agent definitions
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #231 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** The first M4 workers ran through T3 delegate_task; they had no role definitions or hooks. The owner asked to fix it.
- **Lesson:** Use the native Agent tool with subagent_type and worktree isolation; verify a hook (e.g. protect-tests) is active.
- **Action:** Switched on 2026-11-01; recorded in the run B record.

### L-183: Every roborev fix made in a green phase needs a test-writer pin afterwards
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #62 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** Implementers cannot write tests (protect-tests hook), so roborev fixes landed untested on almost every M4 to M6 ticket; reviews then blocked on them, and several pins found real bugs (e.g. M6.03's lost 'Sent, unconfirmed').
- **Lesson:** Budget a pin round after every green phase that fixed findings; list 'untested fix commits' in each report.
- **Action:** Applied as standard practice from M4.08 on.

### L-182: A ticket's fake adapter can hide the shipped default's semantics
- **Date:** 2026-11-01 · **Milestone:** M4 · **Ticket:** #49 · **Recorded by:** lead (CTO session, M4.RT)
- **What happened:** M4.08's red tests injected a fake execFile, so the real default (await exit vs launch) was never exercised; the code review caught it after the implementer rebutted roborev with 'the tests pin it'.
- **Lesson:** Pin real adapters against harmless real programs, not only fakes.
- **Action:** Pinned in M4.08 (#273).

### L-181: A brew upgrade of claude-code deletes the binary path that teammate spawns use
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** none · **Recorded by:** lead (CTO session)
- **What happened:** After a brew upgrade, four M3 workers died at launch (status 127) while the Agent tool reported success.
- **Lesson:** Restart the lead after a Claude upgrade (`claude --continue`), and check pane liveness after each spawn.
- **Action:** memory note (restart-lead-after-claude-upgrade).

### L-180: The auto-mode classifier blocks gh pr merge --admin without an owner instruction
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** none · **Recorded by:** lead (CTO session)
- **What happened:** The classifier blocked `gh pr merge --admin` and ruleset edits (26292100, 26292102), and merges stalled for about three hours.
- **Lesson:** Get an explicit owner standing order for merging reviewed, green PRs before the merge step.
- **Action:** Owner standing order to merge own reviewed PRs with --admin (2026-10-31).

### L-179: Chained merge-commit PRs on integration bases work without force pushes
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** none · **Recorded by:** lead (CTO session)
- **What happened:** Tickets were built on integration bases (87691b5, 81f7258, 6ea33b3) and merged as a chain. Cross-ticket conflicts were only mount lines, but other tickets' interface changes broke tests: LabelSprite props, OverlayRoot needing a SessionProvider, and the settings store listener against a stubbed window.
- **Lesson:** Expect interface changes from earlier chain steps to break later tests, and fix them inside the chain.
- **Action:** PRs #238 to #267.

### L-178: The e2e suite shared one engine, so pairing codes ran out and demo agents leaked
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** none · **Recorded by:** lead (CTO session)
- **What happened:** Single-use pairing codes ran out (`taskville serve` keeps only five) and demo agents leaked across specs. CI web-smoke failed from M3.06 onward.
- **Lesson:** Run one engine per spec file, and issue the running spec's codes last.
- **Action:** #255 (one engine per spec file).

### L-177: roborev pre_merge panels on each chain step found medium findings after ticket reviews passed
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** none · **Recorded by:** lead (CTO session)
- **What happened:** Panels on each chain step found 15 medium findings: a sync abort race, instanced meshes lost on theme switch, settings and theme wiring, and test robustness.
- **Lesson:** Run a pre_merge panel on each chain step; ticket-level review does not catch cross-ticket interactions.
- **Action:** #256, #257, #258, #237.

### L-176: The M3.13 celebrations pixel check never verified particles
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #45 · **Recorded by:** lead (CTO session)
- **What happened:** The screenshot landed after a 700 ms effect, and the tolerance matched scenery. A negative control found 229 false pixels.
- **Lesson:** Give each e2e pixel assertion a negative control, and do not assert on a timing-dependent frame.
- **Action:** Replaced by a deterministic burst.browser.test.tsx (M3.13 6d82536).

### L-175: A minifier keeps code behind a function-wrapped import.meta.env check
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #233 · **Recorded by:** lead (CTO session)
- **What happened:** A gate written as a function left test hooks in the production bundle. Only a literal comparison at the use site was dead-code eliminated.
- **Lesson:** Write `import.meta.env.VITE_TV_TEST_HOOKS === "1"` literally at each guard, and grep the built bundle to confirm.
- **Action:** #233 (M3.19).

### L-174: Browser test flakes came from software WebGL stalls, not rAF throttling
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #263 · **Recorded by:** lead (CTO session)
- **What happened:** SwiftShader, shared by parallel test pages, stalled for 4 to 4.5 s. The page stayed visible and rAF ran at 60 Hz until the stall.
- **Lesson:** Do not cap waits at `vi.waitFor`'s 1 s default or count fixed frames; wait on a condition with a generous bound.
- **Action:** #263.

### L-173: Reviewer and debugger agents cannot run tests or create files under their guards
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** none · **Recorded by:** lead (CTO session)
- **What happened:** The lead ran the checks and wrote the reports for the reviewer and debugger.
- **Lesson:** Brief reviewers with the lead's check results.
- **Action:** none, awareness only (practice: the lead supplies check results in each review brief).

### L-172: Worker handoffs over about 16,000 characters were truncated in delivery
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** none · **Recorded by:** lead (CTO session)
- **What happened:** Long handoffs were truncated in delivery several times.
- **Lesson:** When a handoff arrives cut off, ask for a short resend.
- **Action:** Briefs now cap handoff length (lead practice; no link).

### L-171: The close-worker script's ls-remote pattern also matches m3/<KEY> chain branches
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** none · **Recorded by:** lead (CTO session)
- **What happened:** Once chain branches existed, the `ls-remote --heads` pattern matched them and the script refused to run.
- **Lesson:** Check the script's match pattern before relying on it with chain branches.
- **Action:** none, awareness only (owner's script).

### L-170: Static file serving must be tested on a real socket
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #26 · **Recorded by:** M3.01 report (agent not named)
- **What happened:** hono `serveStatic` followed symlinks out of the web directory and served dotfiles. `app.request("/../x")` normalizes `..` before the app sees it, so the traversal test passed vacuously.
- **Lesson:** Test traversal with a real-socket request and a raw request line. Check the resolved path against hidden files too, since a public-looking symlink can point to a hidden file.
- **Action:** PR #229 (own static handler in apps/engine/src/http/static.ts).

### L-169: Mount catch-all static handlers with app.use, not app.get("*")
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #26 · **Recorded by:** M3.01 report (agent not named)
- **What happened:** `app.get("*")` added a route-table entry that the CLI route-table test pins.
- **Lesson:** Use `app.use` so the static handler stays out of the pinned route table.
- **Action:** PR #229.

### L-168: Do not clear a pairing code before the exchange can be retried
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #26 · **Recorded by:** M3.01 report (agent not named)
- **What happened:** The code was cleared from the address bar before the exchange, so a network failure could not be retried. A link pasted into the same tab fires only `hashchange`.
- **Lesson:** On failure, ask for a new link rather than offering a retry that cannot work, and listen for `hashchange`.
- **Action:** PR #229.

### L-167: An async check that can delete state must delete only what it checked
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #26 · **Recorded by:** M3.01 report (agent not named)
- **What happened:** A 401 check on a stored session could delete a newer session. The second panel found it after a fix added a second way to start an attempt.
- **Lesson:** Delete only the state the check read, and drop the result of a superseded attempt.
- **Action:** PR #229.

### L-166: Vite types CSS Module lookups as index signatures
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #26 · **Recorded by:** M3.01 report (agent not named)
- **What happened:** With `noUncheckedIndexedAccess`, CSS Module class lookups become `string | undefined`.
- **Lesson:** Turn that one flag off for the web package rather than guarding each lookup.
- **Action:** none, awareness only.

### L-165: Vitest Browser Mode needs the Chromium revision that matches the installed Playwright
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #26 · **Recorded by:** M3.01 report (agent not named)
- **What happened:** The first browser run after an install failed one test with a React context error and passed on the next run. The cause was not found.
- **Lesson:** After a Playwright bump, run `pnpm exec playwright install chromium`, and record any one-off browser failure with its text.
- **Action:** none, awareness only.

### L-164: A web workspace package must declare a dependency before it can import it
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #30 · **Recorded by:** M3.02 report (agent not named)
- **What happened:** `apps/web/package.json` lacked `@taskville/domain` and `@taskville/protocol`, so `src/data/domain.ts` used relative paths.
- **Lesson:** Keep one import seam file, so adding the dependency is a one-file change.
- **Action:** none, awareness only (wiring left for the lead).

### L-163: A fake engine that replays real reducer state can assert no gap or duplicate by hash
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #30 · **Recorded by:** M3.02 report (agent not named)
- **What happened:** The data-layer test replayed a real event log through a fake engine and compared state hashes.
- **Lesson:** Assert gap-free, duplicate-free sync against replayed reducer state, not hand-built expectations.
- **Action:** none, awareness only.

### L-162: Keep geometry in pure .ts modules so node tests can cover it
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #31 · **Recorded by:** M3.03 report (agent not named)
- **What happened:** Projection, collision and registry logic lived in pure modules, testable in node without a browser. The React layer stayed thin.
- **Lesson:** Put logic in pure modules, and leave browser tests for the React layer.
- **Action:** none, awareness only.

### L-161: elementFromPoint assertions need element identity, not textContent
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #31 · **Recorded by:** M3.03 report (agent not named)
- **What happened:** A wrapper that contains the text matched a textContent assertion.
- **Lesson:** Assert the element returned by `document.elementFromPoint` by identity.
- **Action:** none, awareness only.

### L-160: Biome's noComponentHookFactories flags fixtures built inside test helpers
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #31 · **Recorded by:** M3.03 report (agent not named)
- **What happened:** Biome flagged fixture components built inside test helper functions.
- **Lesson:** Use a targeted `biome-ignore` with a reason.
- **Action:** none, awareness only.

### L-159: Playwright alone serves a stale dist
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #32 · **Recorded by:** M3.04 report (agent not named)
- **What happened:** The scaffold e2e script builds before it tests, but `playwright test` on its own serves the old dist, so the screenshot did not change.
- **Lesson:** Rebuild after a visual change before running e2e.
- **Action:** none, awareness only.

### L-158: The fixed e2e port collides between parallel workers
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #32 · **Recorded by:** M3.04 report (agent not named)
- **What happened:** Port 4817 in the scaffold Playwright config is shared by every worker running e2e.
- **Lesson:** Set `E2E_PORT` to a free port for each run.
- **Action:** none, awareness only.

### L-157: Dark albedos render near-black under ACES tone mapping
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #32 · **Recorded by:** M3.04 report (agent not named)
- **What happened:** With default ACES tone mapping and ambient light 1, albedos near #2b3340 rendered almost black.
- **Lesson:** Use mid-grey albedos for ground that must read against a dark scene.
- **Action:** none, awareness only.

### L-156: drei Html labels lose the first label under StrictMode
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #33 · **Recorded by:** M3.05 report (agent not named)
- **What happened:** drei `Html` labels lost their first label when React runs effects twice, and the app uses StrictMode.
- **Lesson:** Use a canvas-texture sprite per agent instead; it needs no DOM.
- **Action:** none, awareness only.

### L-155: page.screenshot in a vitest browser test captures the whole page
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #33 · **Recorded by:** M3.05 report (agent not named)
- **What happened:** `page.screenshot` saves relative to the test file and captures the whole page.
- **Lesson:** Screenshot a `data-testid` element instead.
- **Action:** none, awareness only.

### L-154: A navigator that owns no clock is testable with a fake clock
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #36 · **Recorded by:** M3.06 report (agent not named)
- **What happened:** `tick(nowMs)` with fixed substeps let every rule run in node, including a frame-by-frame determinism check.
- **Lesson:** Give simulation logic an explicit clock input.
- **Action:** none, awareness only.

### L-153: Mutual-yield rules need a tie-break that also makes room
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #36 · **Recorded by:** M3.06 report (agent not named)
- **What happened:** "The smaller id goes" let the winner walk through the loser.
- **Lesson:** Back the loser off along its own street.
- **Action:** none, awareness only.

### L-152: Agents spawned at one point walk in lockstep and cannot be separated
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #36, #257 · **Recorded by:** M3.06 report (agent not named)
- **What happened:** Agents spawned at one point in one sync shared a path, and no "ahead" check could separate them (M3.06). A subagent with no destination never walks, so spawn placement alone kept siblings apart (M3.24).
- **Lesson:** Use distinct spawn points.
- **Action:** none, awareness only.

### L-151: Run the CLI in process from a Playwright spec
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #36 · **Recorded by:** M3.06 report (agent not named)
- **What happened:** Calling the CLI's `run([...], io)` in process drove the real demo producer against the e2e engine.
- **Lesson:** Use in-process `run()` for e2e setup, once the harness shares its home.
- **Action:** none, awareness only.

### L-150: Theme tokens need a color rule, not just key names
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #37 · **Recorded by:** M3.07 report (agent not named)
- **What happened:** The 3D side (three.js `Color`) and CSS needed the same values.
- **Lesson:** Test that every theme color is `#rrggbb`.
- **Action:** none, awareness only.

### L-149: Theme modules must not import core/index.ts
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #37 · **Recorded by:** M3.07 report (agent not named)
- **What happened:** The registry imports the themes, so the reverse import would be a cycle.
- **Lesson:** Import from `core/contract.ts` in theme modules.
- **Action:** none, awareness only.

### L-148: The accent height rule caps a chimney at about 2.9 m
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #41 · **Recorded by:** M3.08 report (agent not named)
- **What happened:** The rule (building height + 3 m) caps a chimney at about 2.9 m above the roof.
- **Lesson:** A taller stack needs a contract change, not a theme tweak.
- **Action:** none, awareness only.

### L-147: Theme screenshots need a theme hook; swapping the default is the workaround
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #41, #43, #235 · **Recorded by:** M3.08 report (agent not named)
- **What happened:** Nothing let a screenshot run pick a theme (M3.08), so per-theme screenshots needed a temporary default swap (M3.10). After the theme moved to the settings store, reordering `THEMES` stopped selecting a theme, and four screenshots came out byte-identical (M3.21).
- **Lesson:** For a screenshot run, swap `DEFAULT_SETTINGS.theme`. A `?theme=` hook or an exposed controller would make per-theme screenshots reproducible.
- **Action:** none, awareness only.

### L-146: Check each theme once in the real render
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #42 · **Recorded by:** M3.09 report (agent not named)
- **What happened:** A near-white token still reads grey under the shared lights.
- **Lesson:** Check each theme once in the real render, not by palette alone.
- **Action:** none, awareness only.

### L-145: sips -c silently ignores --cropOffset
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #42 · **Recorded by:** M3.09 report (agent not named)
- **What happened:** `sips -c` with `--cropOffset` left the full image.
- **Lesson:** Crop with a Playwright `clip` screenshot of the file.
- **Action:** none, awareness only.

### L-144: git commit -a skips untracked files
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #43 · **Recorded by:** M3.10 report (agent not named)
- **What happened:** A new theme folder was left out of a commit that already registered it.
- **Lesson:** Run `git status` before every commit.
- **Action:** none, awareness only.

### L-143: Raycaster needs matrixWorld current in unit tests
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #38 · **Recorded by:** M3.11 report (agent not named)
- **What happened:** Without `updateMatrixWorld(true)`, every object tests at the origin, so a pick can pass by coincidence.
- **Lesson:** Call `updateMatrixWorld(true)` in unit-test scenes.
- **Action:** none, awareness only.

### L-142: Read a point's screen position from the running scene
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #38 · **Recorded by:** M3.11 report (agent not named)
- **What happened:** A test recomputed a screen position from camera math that disagreed with the drawn camera, so it passed against the wrong camera.
- **Lesson:** Ask the scene for the anchor projection instead of recomputing it in the test.
- **Action:** none, awareness only.

### L-141: Fade a building by cloning its material, not changing the shared one
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #38 · **Recorded by:** M3.11 report (agent not named)
- **What happened:** Buildings share per-tone materials. Instanced windows cannot be faded per building.
- **Lesson:** Clone per building on first fade and swap. Scale a building's instances to zero instead of fading instanced windows.
- **Action:** none, awareness only.

### L-140: On macOS, sed -i needs an empty suffix argument
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #38 · **Recorded by:** M3.11 report (agent not named)
- **What happened:** Without the empty suffix, the next path was read as the sed script.
- **Lesson:** Use `sed -i ''`.
- **Action:** none, awareness only.

### L-139: First paint of the WebGL canvas can exceed Playwright's 5 s default under load
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #38 · **Recorded by:** M3.11 report (agent not named)
- **What happened:** Other workers loading the machine pushed first paint past the default.
- **Lesson:** Give the first `toBeVisible` on the canvas a longer timeout.
- **Action:** none, awareness only.

### L-138: A fixed-clock browser makes time-of-day visuals reproducible
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #44 · **Recorded by:** M3.12 report (agent not named)
- **What happened:** `page.clock.setFixedTime` with `timezoneId` fixed the time of day in e2e, with no app test hook.
- **Lesson:** Use the fixed clock for time-of-day visuals.
- **Action:** none, awareness only.

### L-137: A lighting ticket should own where its lights are declared
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #44 · **Recorded by:** M3.12 report (agent not named)
- **What happened:** Ambient and sun lights declared in `SceneRoot` and `CityScene` could not be driven from the lighting folder.
- **Lesson:** Give the lighting ticket ownership of the light declarations.
- **Action:** none, awareness only.

### L-136: Charge a rate limit for what was shown, not what was wanted
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #45 · **Recorded by:** M3.13 report (agent not named)
- **What happened:** The trigger rules are pure, but the renderer knows whether something could be drawn. An undrawn celebration started the 2 s window.
- **Lesson:** The renderer reports back through a callback, and the rate limit is charged only when it draws.
- **Action:** none, awareness only.

### L-135: Filter old facts before any state tracking
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #45 · **Recorded by:** M3.13 report (agent not named)
- **What happened:** Imported and late events could arm or clear a shimmer.
- **Lesson:** Filter them at the top of the rules, before state tracking.
- **Action:** none, awareness only.

### L-134: A component library can drop an ARIA attribute silently
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #46 · **Recorded by:** M3.14 report (agent not named)
- **What happened:** A library component dropped an ARIA attribute passed to it.
- **Lesson:** Assert the attribute on the rendered DOM, and prefer the library's own selection state.
- **Action:** none, awareness only.

### L-133: React Aria inputs are visually clipped inside their label
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #39 · **Recorded by:** M3.15 report (agent not named)
- **What happened:** Radio and switch inputs render clipped inside their `<label>`.
- **Lesson:** In component tests, click the label text, then assert on the role.
- **Action:** none, awareness only.

### L-132: Do not give a React Aria group both aria-label and a Label child
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #39 · **Recorded by:** M3.15 report (agent not named)
- **What happened:** The name doubled ("Day and night Day and night"), and `getByRole` by name missed it. A Switch label with a note also ran the note into the name.
- **Lesson:** Use `aria-label` for the name and `aria-describedby` for the note.
- **Action:** none, awareness only.

### L-131: Clear the queued flag when a walker leaves a line
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #232 · **Recorded by:** M3.18 report (agent not named)
- **What happened:** A walker skipped at the head of a line kept a stale `queued` flag, and later "still in line" tests trusted it.
- **Lesson:** Clear the flag at the point of removal.
- **Action:** none, awareness only.

### L-130: Share a value between sibling components through a small module store
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #234 · **Recorded by:** M3.20 report (agent not named)
- **What happened:** `DayNightLighting` is a sibling of `ThemedCity` and could not reach materials created inside `CityScene`. A module store in `materials.ts` carries the emissive level.
- **Lesson:** Keep the dependency one-way: lighting imports buildings, never the reverse, since themes imports buildings.
- **Action:** none, awareness only.

### L-129: The palette flip at nightness 0.5 is a visible step
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #234 · **Recorded by:** M3.20 report (agent not named)
- **What happened:** The emissive level is continuous, but the theme palette flips day to night at nightness 0.5, so the glow color steps (cyberpunk lamp #5fe3ff to #9af5ff).
- **Lesson:** Blend day and night palettes by nightness if the step matters. M3.20 did not fix it.
- **Action:** none, awareness only (the report files no follow-up ticket).

### L-128: E2E_SCREENSHOT is resolved against apps/web
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #235 · **Recorded by:** M3.21 report (agent not named)
- **What happened:** A relative `E2E_SCREENSHOT` path resolves against `apps/web`, not the repo root.
- **Lesson:** Pass an absolute path.
- **Action:** none, awareness only.

### L-127: A prop default that falls back hides missing wiring
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #237 · **Recorded by:** M3.22 report (agent not named)
- **What happened:** Both components worked in isolation. Only a test on the mount point (`CityRoot`) caught that the settings value never arrived.
- **Lesson:** Test wiring at the mount point.
- **Action:** #237.

### L-126: toHaveTextContent cannot match a regex in vitest-browser 5.0.5
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #256 · **Recorded by:** M3.23 report (agent not named)
- **What happened:** `toHaveTextContent` compares `String(t)` for equality, so a regex argument can never pass and fails typecheck.
- **Lesson:** Use `toMatchTextContent` for regex matches.
- **Action:** none, awareness only.

### L-125: Check the abort signal after every await in the sync loop
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #256 · **Recorded by:** M3.23 report (agent not named)
- **What happened:** The sync loop did not check `signal.aborted` after awaits, which left an abort race.
- **Lesson:** Check the signal after every await, and cancel the SSE reader on abort.
- **Action:** #256.

### L-124: Instanced meshes rebuild when their geometry or material changes
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #257 · **Recorded by:** M3.24 report (agent not named)
- **What happened:** React Three Fiber rebuilds an instanced mesh when either constructor argument changes, so per-instance data written in an effect keyed on the data alone was lost on a theme switch.
- **Lesson:** Write per-instance data in a ref callback, which runs with the new mesh.
- **Action:** #257.

### L-123: Raycasting ignores visible
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #257 · **Recorded by:** M3.24 report (agent not named)
- **What happened:** Hidden objects still got picked.
- **Lesson:** Picking has to check the object and its ancestors for visibility itself.
- **Action:** #257.

### L-122: Gate hover repicks on pointer presence and not dragging
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #257 · **Recorded by:** M3.24 report (agent not named)
- **What happened:** A camera change from a drag, or with the pointer outside the canvas, repicked hover on every move.
- **Lesson:** Repick only while the pointer is inside the canvas and not dragging.
- **Action:** #257.

### L-121: A panel in a clipped, absolutely sized slot needs its own scroll container
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #258 · **Recorded by:** M3.25 report (agent not named)
- **What happened:** The expanded settings panel ran past the clipped sidebar slot at short viewports.
- **Lesson:** Set max-height 100% and min-height 0 down the flex chain.
- **Action:** #258.

### L-120: A store that skips unchanged values cannot drive a system that can diverge
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #258 · **Recorded by:** M3.25 report (agent not named)
- **What happened:** The theme picker showed the stored theme, not the one in use, and re-choosing the stored theme did nothing.
- **Lesson:** Apply the choice to the controller directly, and store it as well.
- **Action:** #258.

### L-119: Drive frames by hand in animation tests
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #263 · **Recorded by:** M3.26 report (agent not named)
- **What happened:** The work-loop test waited on wall time. Driving 20 ms frames with `advance()` made it deterministic.
- **Lesson:** Use `frameloop="never"` and `advance()` for animation over time. Otherwise wait on a condition (root exists, a frame was drawn) with a generous bound.
- **Action:** #263.

### L-118: Unrelated tests time out when parallel workers load the machine
- **Date:** 2026-10-31 · **Milestone:** M3 · **Ticket:** #26, #30, #31, #234, #257 · **Recorded by:** M3.01 report (agent not named)
- **What happened:** Tests unrelated to each ticket hit 5 s timeouts under parallel workers (load average reached 61 in M3.01) and passed when re-run alone. Each was logged as a load flake.
- **Lesson:** Re-run a load timeout once, alone, and log it as a flake. A second failure is a finding.
- **Action:** none, awareness only.

### L-117: A usage-limit cutoff mid-wave leaves state that only live GitHub can reconcile
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** none · **Recorded by:** lead (M2.RT)
- **What happened:** The first M2 lead session hit its usage limit with M2.10 committed but unreported, M2.19 assigned but never started, M2.18's correction unpushed, and STATUS behind seventeen merges. Recovery and this resume reconciled from GitHub, refs and worktrees before assigning anything.
- **Lesson:** Read the live usage display before assigning, set a stop time in every brief, and have each worker push a checkpoint and hand off before the cutoff, so an interruption leaves pushed branches, not local state.
- **Action:** Stop times and handoff block in the resume worker brief; usage policy approved by the owner (RECOVERY-2026-10-31).

### L-116: Generic workers inherit the lead's model unless every assignment names one
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** none · **Recorded by:** lead (M2.RT)
- **What happened:** The first M2 wave spawned general-purpose teammates with no model setting, so they ran on the lead's Opus, and the temporary brief hard-coded Opus attribution.
- **Lesson:** State provider, model, effort and the reason on every assignment, and attribute commits to the model that wrote them.
- **Action:** Applied in this resume (Sonnet medium or high for tickets, Haiku low for the lessons copy).

### L-115: Redactor reviews do not converge on hand-parsed command lines
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #211 · **Recorded by:** lead (M2.RT)
- **What happened:** M2.22's command-line password rules drew high findings in four rounds (5357, 5377, 5388/5399, 5415/5412), each a new crafted shape, as M1.20 and M1.18 F3 did (L-40). The lead verified the last four also leak on main, merged the strict improvement, and routed the class to a decision.
- **Lesson:** When a finding class survives two fix attempts, stop, check whether the remaining findings are regressions or pre-existing gaps, and escalate the strategy instead of patching shapes.
- **Action:** Decision #223; gaps tracked in #222.

### L-114: A worker ran seven review panels on one ticket
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #212 · **Recorded by:** lead (M2.RT)
- **What happened:** M2.23 ran pre-merge panels 5360 to 5409, each finding a new symlink or ancestor edge case, before a pass. The brief said re-review once; the hook kept prompting fix sessions.
- **Lesson:** The review-round cap must be in the worker brief as a hard stop with a report to the lead, and the roborev Stop hook prompts do not override it.
- **Action:** Proposed in docs/retros/M2.md (change 3).

### L-113: Measurements taken while other workers run are not measurements
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #166 · **Recorded by:** lead (M2.RT)
- **What happened:** M2.18's 28.7% rerun overlapped M2.16's soak and was invalid; the clean replacement read 39.7% with tests and reviews still running. The wave's perf batch and latency runs were taken after every worker had stopped.
- **Lesson:** Run perf only with the machine reserved, log what else ran, and treat a number taken under contention as invalid rather than as a lower bound.
- **Action:** Correction posted on #206 and #166; wave perf run with no workers active.

### L-112: Tightening a timing assertion makes a shared-machine e2e load-sensitive (flake F-2)
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #34 · **Recorded by:** lead (M2.RT)
- **What happened:** After the one-second visibility check began counting shim time, two replay runs failed 1 and then 3 checks at load average 8 to 12; alone it passed 7/7, and the wave run on main passed 7/7. Failure text was not captured.
- **Lesson:** Capture failure text on the first failing run, and keep timing e2e runs off a machine that is running other suites.
- **Action:** Logged as flake F-2; watch the one-second budget.

### L-111: A stateless mapper can only join lead and teammate by what both hooks carry
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #209 · **Recorded by:** lead (M2.RT)
- **What happened:** Team names are `session-<first 8 hex of the lead session>`, so M2.20 scopes team-less tasks the same way. roborev rated the 32-bit collision high; the worker answered with evidence and the lead accepted it, since team IDs already share the limit.
- **Lesson:** Record accepted trade-offs on review findings in the gate summary so the owner sees them.
- **Action:** Listed in the G2 summary.

### L-110: A loop whose awaits never do I/O does not yield, so bound its work per tick
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #35 · **Recorded by:** M2.11 teammate
- **What happened:** The M2 security review found a loop after `listen` whose awaits never did I/O, so it never gave the event loop a turn.
- **Lesson:** After `listen`, bound the work each tick does; an await on a value that is already resolved does not hand control back.
- **Action:** none, awareness only

### L-109: The installer and shim create the Taskville home without the engine's owner and mode checks
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #35 · **Recorded by:** M2.11 teammate
- **What happened:** The installer and the shim created the same home as the engine but skipped its owner and mode checks (review finding F3).
- **Lesson:** Any code path that creates the engine's home must run the same owner and mode checks, not a copy of the create step.
- **Action:** Made in #220 (M2.23)

### L-108: Redacting by the last word of a name misses compound and abbreviated env names
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #35 · **Recorded by:** M2.11 teammate
- **What happened:** Names such as `PGPASSWORD`, `MYSQL_PWD`, `*_PASS` and `mysql -p<pw>` reached the event log and `evidence.db` unmasked (review finding F2).
- **Lesson:** Match sensitive names on the whole name, including compound and abbreviated forms, and test them with real examples.
- **Action:** Made in #219 (M2.22)

### L-107: Blocking one git config key leaves the others open
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #35 · **Recorded by:** M2.11 teammate
- **What happened:** Blocking `core.fsmonitor` alone left a partial-clone lazy fetch that still ran `remote.<r>.uploadpack` from a read-only `for-each-ref` (review finding F1).
- **Lesson:** Prefer environment kill switches and a hostile test repository built for the purpose over blocking individual config keys.
- **Action:** Made in #218 (M2.21)

### L-106: A window limit on a scan is a bypass when the text is attacker-shaped
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #211 · **Recorded by:** M2.22 teammate
- **What happened:** A bounded window on a redaction scan let attacker-shaped text get past masking.
- **Lesson:** Either scan to the real boundary or mask more, never less.
- **Action:** Made in #219 (M2.22)

### L-105: Do not parse another tool's option grammar when a coarse rule over-masks safely
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #211 · **Recorded by:** M2.22 teammate
- **What happened:** A bounded word-walk over `docker` global options leaked at the limit, was quadratic on a crafted word, and took three review rounds to get right.
- **Lesson:** When a coarse rule can over-mask safely, use it. A segment that contains `login` is linear and cannot be outrun.
- **Action:** none, awareness only

### L-104: Each rule that reads a value needs its own idempotency check
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #211 · **Recorded by:** M2.22 teammate
- **What happened:** A sealed number left `"value":[REDACTED:...]`, and the loose value end cut at the `]` inside the marker, which broke idempotency.
- **Lesson:** Test every rule that reads a value for idempotency, and do not let a loose value end cut through a redaction marker.
- **Action:** none, awareness only

### L-103: A pair rule must cover both property orders, line breaks and values of any size, at a cost that does not depend on order
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #211 · **Recorded by:** M2.22 teammate
- **What happened:** Masking a name and value pair had to handle either order, line breaks, and values of any size.
- **Lesson:** Scan forward from a name (an unclosed value masks to the end, paid once). Scan back only to a value that closes exactly at the comma, with a budget and over-masking as the fallback.
- **Action:** none, awareness only

### L-102: A password flag has to be tied to its command's own option parsing
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #211 · **Recorded by:** M2.22 teammate
- **What happened:** `-p` is a port in `ssh`, `psql` and `docker run`, so a flag rule that ignores the command masks the wrong thing. `sshpass` runs another command whose own `-p` must stay readable.
- **Lesson:** Parse the options of the command the flag belongs to, up to that command, so that `ssh -p 2222` stays readable.
- **Action:** Made in #219 (M2.22)

### L-101: Mirror a refuse-only check instead of importing a function that mutates
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #212 · **Recorded by:** M2.23 teammate
- **What happened:** The engine's `ensurePrivateDir` mkdirs and chmods and throws `HomeError`, so the installer's rule, which must only refuse, could not import it.
- **Lesson:** Export the check with an injectable stat, and mirror it where the rule must only refuse.
- **Action:** Made in #220 (M2.23)

### L-100: The shim must vet the Taskville home before it creates the spool or reads the token
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #212 · **Recorded by:** M2.23 teammate
- **What happened:** A home check that runs after the spool is created inside the home, or after the token is read from it, protects nothing.
- **Lesson:** Run the home check first in every path that writes into or reads from the home.
- **Action:** Made in #220 (M2.23)

### L-99: Walk path ancestors from `/`, resolving symlinks, and start at the nearest existing ancestor
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #212 · **Recorded by:** M2.23 teammate
- **What happened:** `realpath` hides writable directories that held a symlink, lexical folding of `..` skips links, `/` itself needs the same check, and a symlink's owner matters even inside a sticky directory. The home may also not exist yet at install time, and macOS `/var` is a symlink to `/private/var`.
- **Lesson:** Walk the components from `/` and check each one, starting at the nearest existing ancestor.
- **Action:** Made in #220 (M2.23)

### L-98: Clean up spawned engines on failure paths as well as success
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #34 · **Recorded by:** M2.10 teammate
- **What happened:** A leftover engine from a failed end-to-end run kept `node --test` from exiting.
- **Lesson:** Make teardown stop the engine even when the run fails.
- **Action:** none, awareness only

### L-97: A tighter timing assertion on a loaded machine makes an end-to-end test load-sensitive
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #34 · **Recorded by:** M2.10 teammate
- **What happened:** Tightening a timing assertion on a shared, loaded machine made the end-to-end run load-sensitive.
- **Lesson:** Capture the failure text on the first failing run, so a load flake can be told apart from a real failure.
- **Action:** none, awareness only

### L-96: Model and session attribution must describe the agent that actually made each change
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #34 · **Recorded by:** M2.10 teammate
- **What happened:** The end-to-end run showed that model and session attribution had to describe the agent that made each change, not a single session.
- **Lesson:** Attribute each change to the agent that actually made it.
- **Action:** none, awareness only

### L-95: A process exit of 0 with a TODO is not an acceptance pass
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #34 · **Recorded by:** M2.10 teammate
- **What happened:** The real Claude Code session run exited with status 0 while a TODO was still open.
- **Lesson:** Judge acceptance from the checks themselves, not from the process exit code.
- **Action:** none, awareness only

### L-94: Terminal async hooks can be dropped when a short-lived Claude process exits
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #34 · **Recorded by:** M2.10 teammate
- **What happened:** Async hooks that fire at the very end of a short-lived Claude Code process were not always delivered.
- **Lesson:** Record synchronously when the last hooks matter.
- **Action:** none, awareness only

### L-93: A command with no engine-free seam can be tested against a canned HTTP server
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #207 · **Recorded by:** M2.19 teammate
- **What happened:** The `requests` command had no engine-free seam for its test.
- **Lesson:** Serve canned snapshots from a small `node:http` server and run the real command against it; no engine or fixtures needed.
- **Action:** none, awareness only

### L-92: `pnpm --filter ... test -- <file>` ignores the file filter
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #210 · **Recorded by:** M2.21 teammate
- **What happened:** `pnpm --filter @taskville/engine test -- <file>` ran all 35 test files.
- **Lesson:** Run one file with `npx vitest run --project @taskville/engine <path>`.
- **Action:** none, awareness only

### L-91: A sed mutation can leave a dangling `-c` and make a test pass for the wrong reason
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #210 · **Recorded by:** M2.21 teammate
- **What happened:** A sed mutation left a dangling `-c`, so git failed and a marker-file test passed without testing the guard.
- **Lesson:** After a mutation, check that the run still gets real git output, such as the rest of the test file passing.
- **Action:** none, awareness only

### L-90: A blanket `protocol.allow=never` is overridden by the repository's own config
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #210 · **Recorded by:** M2.21 teammate
- **What happened:** The repository's own `protocol.<name>.allow=always` overrode the blanket setting, and the `ext::` case ran. Only a mutation run showed it.
- **Lesson:** Override per transport with `-c`, and add an environment kill switch, because a hostile repository config can beat a blanket line.
- **Action:** Made in #218 (M2.21)

### L-89: A recovery snapshot can lag GitHub and the board
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** none · **Recorded by:** lead
- **What happened:** A recovery snapshot lagged GitHub and the project board.
- **Lesson:** Reconcile from live state before assigning work.
- **Action:** none, awareness only

### L-88: Check the redaction rules before trusting a fixture relation
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #209 · **Recorded by:** M2.20 teammate
- **What happened:** The `session-<8 hex>` team name matched the lead's session ID. Redaction keeps IDs, so the match is real, and four recordings agree.
- **Lesson:** Before reading a relation in a fixture as real, check whether the redaction rules keep the values it depends on.
- **Action:** none, awareness only

### L-87: A stateless mapper must scope by a value that stays derivable later
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #209 · **Recorded by:** M2.20 teammate
- **What happened:** A lead cannot know it leads a team when its first task hook fires. `team_name` is derived from the lead's `session_id`. Existing task IDs change, so a task created before the upgrade and completed after it lands on a task that was never created.
- **Lesson:** Scope a stateless mapper by a value that can be derived later from the same stream.
- **Action:** none, awareness only

### L-86: Derive each retention protection from the reducer rule that will read the record
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #167 · **Recorded by:** M2.16 teammate
- **What happened:** Each protection (a live child's parent, a team lead, open requests, running calls) was found by asking which reducer rule would later look the record up.
- **Lesson:** Ask which reducer rule will read a record before deciding that it can be pruned.
- **Action:** none, awareness only

### L-85: Bounding state did not bound RSS on the calm run
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #167 · **Recorded by:** M2.16 teammate
- **What happened:** On the lively run RSS growth fell from +20 to +29% down to -26%, but the calm run stayed at +18% with state flat from hour 6.
- **Lesson:** Measure state size and RSS side by side, so that a bounded state is not read as a bounded RSS.
- **Action:** none, awareness only

### L-84: A metric's run-to-run spread larger than its threshold cannot be passed by fixing code
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #166 · **Recorded by:** M2.18 teammate
- **What happened:** SC-006 run-to-run spread (hour 1 alone ranged from 102.6 to 125.5 MiB) is larger than its 10% threshold. The valid after runs gave 14.0% and 39.7% on the same code. Projection state grew by 121 KiB against an RSS difference of 17.6 to 31.1 MiB, so #167 alone will not close it as measured.
- **Lesson:** Check the noise before reading a pass or a fail; a spread wider than the threshold cannot be fixed in code.
- **Action:** none, awareness only

### L-83: A perf baseline is valid only if the engines started before the first source edit
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #166 · **Recorded by:** M2.18 teammate
- **What happened:** The baseline was taken from a worktree that was being edited.
- **Lesson:** Check the engines' start timestamps against the first source edit, or measure from a clean checkout.
- **Action:** none, awareness only

### L-82: Engine-assigned event IDs break cross-database equivalence tests
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #166 · **Recorded by:** M2.18 teammate
- **What happened:** Two engines fed the same events produced different `stateHash` values, because engine-assigned event IDs are part of the state. The first version of the test failed on that, not on the cache.
- **Lesson:** Use deterministic `newEventId` values in equivalence tests across databases.
- **Action:** none, awareness only

### L-81: Two parallel tickets that both bump `REDUCER_VERSION` collide
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #143 · **Recorded by:** M2.15 teammate
- **What happened:** Two parallel tickets both bumped `REDUCER_VERSION`. The second to merge had to bump again after rebasing (3 to 4), and its red pins were dropped as already upstream.
- **Lesson:** Expect the second ticket to merge to need one more version bump after rebasing.
- **Action:** none, awareness only

### L-80: Check which payloads can carry a shape before documenting a hash migration
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #194 · **Recorded by:** M2.17 teammate
- **What happened:** A hash migration was about to be documented, but the strict schemas meant no stored event could change.
- **Lesson:** Before documenting a migration, check which payloads can actually carry the shape.
- **Action:** none, awareness only

### L-79: When a diff masks per line, mask the line before adding the `+`/`-` prefix
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #194 · **Recorded by:** M2.17 teammate
- **What happened:** Masking after the prefix was added made the prefix part of the token being checked. Quoted copies of the same secret also needed masking.
- **Lesson:** Mask the line first, then add the prefix, and mask quoted copies of the same secret too.
- **Action:** none, awareness only

### L-78: A rule for a sensitive key must say what happens to non-strings, nested values and nested keys
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #194 · **Recorded by:** M2.17 teammate
- **What happened:** The rule "mask the value of a sensitive key" did not say what to do with non-strings, with what sits below the key, or with keys below it. Keeping the structure leaked keys.
- **Lesson:** Seal the whole value. It is simpler and leaks nothing.
- **Action:** Made in #200 (M2.17)

### L-77: A rebase onto a ticket that edited the same function is new code
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #173 · **Recorded by:** M2.12 teammate
- **What happened:** Rebasing onto a ticket that edited the same function produced new code, and reviewing the result found a real issue.
- **Lesson:** Review the rebased result as new code, not as the old change carried forward.
- **Action:** none, awareness only

### L-76: Raw mode means owning shutdown
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #173 · **Recorded by:** M2.12 teammate
- **What happened:** Raw mode stops Ctrl-C from being a signal. Two of the three review findings were exit paths that did not restore the terminal.
- **Lesson:** Every exit path must restore the terminal.
- **Action:** none, awareness only

### L-75: A single-slot design turns a small feature into a change to a security module
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #173 · **Recorded by:** M2.12 teammate
- **What happened:** The "a new code replaces the previous one" design made "old codes keep working" a change to a security module.
- **Lesson:** Add an option whose default keeps the existing behavior, so no existing test has to move.
- **Action:** none, awareness only

### L-74: A projection rule keyed on an adapter's ID format should be an explicit field
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #183 · **Recorded by:** M2.13 teammate
- **What happened:** A projection rule keyed on the adapter's ID format worked, but it is a pragmatic seam.
- **Lesson:** Make it an explicit field that the adapter sets.
- **Action:** none, awareness only

### L-73: Recorded streams hold surprises that a unit test would not
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #183 · **Recorded by:** M2.13 teammate
- **What happened:** In the S-1 recording, the last hook of a session (exp6) is the last event of a session that never ends in the recording.
- **Lesson:** Check "nothing is running after the turn ends" per session, not once for the whole stream.
- **Action:** none, awareness only

### L-72: Read the review guidelines before narrowing a rule
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #183 · **Recorded by:** M2.13 teammate
- **What happened:** An invariant written in `.roborev.toml` decided a review, even though the decision ticket spoke only of telemetry requests. Relaxing bridge requests from "any agent" to "owner only" was still wrong.
- **Lesson:** Read the review guidelines for the rule before narrowing it.
- **Action:** none, awareness only

### L-71: `FileHandle.write` can write short
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #28 · **Recorded by:** M2.07 teammate
- **What happened:** A copy loop advanced by `bytesRead`, but `FileHandle.write` can write fewer bytes than it was given.
- **Lesson:** Advance a copy loop by `bytesWritten`.
- **Action:** Made in #191 (M2.07)

### L-70: A bounded run that rewrites the unread rest of a file is quadratic on a large backlog
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #28 · **Recorded by:** M2.07 teammate
- **What happened:** A bounded run that rewrote the unread rest of a file looked crash-safe, but turned a large backlog into quadratic I/O (roborev 5166).
- **Lesson:** Resume from a byte offset written after commit. It is both cheaper and simpler.
- **Action:** Made in #191 (M2.07)

### L-69: A CLI that edits user config should take HOME only from its injected environment
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #29 · **Recorded by:** M2.08 teammate
- **What happened:** The installer read HOME from the process environment, which is unsafe in tests.
- **Lesson:** Take HOME only from the injected environment; tests are then safe by construction, and a guard on the real file's mtime proves it.
- **Action:** none, awareness only

### L-68: "Uninstall restores the original" needs a definition and odd-formatting tests
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #29 · **Recorded by:** M2.08 teammate
- **What happened:** JSON round-trips are not byte-stable, so the installer cannot undo a hook install by a structural edit.
- **Lesson:** Define "restores the original" as byte-identical when the file is exactly what install wrote, undo through the backup, and test with deliberately odd formatting.
- **Action:** none, awareness only

### L-67: Hook commands run in the agent's environment, so pin every variable the shim reads
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #29 · **Recorded by:** M2.08 teammate
- **What happened:** Hook commands run in the agent's environment, not the installer's.
- **Lesson:** Pin every variable the shim reads instead of relying on defaults.
- **Action:** none, awareness only

### L-66: An installer's diff is an output channel for secrets
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #29 · **Recorded by:** M2.08 teammate
- **What happened:** Masking each line separately missed a value on a later line than its key, escaped spellings, and duplicate keys that `JSON.parse` collapses.
- **Lesson:** Mask by JSON context, and refuse what the parser would hide.
- **Action:** none, awareness only

### L-65: Dating a first-seen ref at its tip's commit time presents a guess as a fact
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #25 · **Recorded by:** M2.09 teammate
- **What happened:** Dating a first-seen ref at its tip's commit time made restart dedupe neat, but it presented an unobserved move as a recorded fact (a roborev high finding).
- **Lesson:** Restore state from the log rather than inventing a date for it.
- **Action:** none, awareness only

### L-64: Text that ingest may mask is not an identity
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #25 · **Recorded by:** M2.09 teammate
- **What happened:** Restoring branch tips from the stored `payload.ref` broke for a branch whose name looked like a token.
- **Lesson:** Restore state from unmasked ID fields such as `sourceEventId`, not from payload text.
- **Action:** none, awareness only

### L-63: A ref-name injection test with full names cannot fail
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #25 · **Recorded by:** M2.09 teammate
- **What happened:** A test using full names such as `refs/heads/--output=x` passed with both defenses removed, because a full ref name always starts with `refs/`.
- **Lesson:** Assert the shape of every argument list the watcher passes to git, instead.
- **Action:** none, awareness only

### L-62: Leaving out a field the other mapper never sets can merge two prompts into one state
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #23 · **Recorded by:** M2.04 teammate
- **What happened:** The reducer's request merge keys on tool name. The worker-prompt request leaves `toolName` out, so the lead's `permission_prompt` that follows merged into one red state.
- **Lesson:** Check what each mapper sets before relying on a merge key.
- **Action:** none, awareness only

### L-61: An emitted heuristic marker is only half the job
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #23 · **Recorded by:** M2.04 teammate
- **What happened:** The domain projection dropped the heuristic marker, so the guess would have shown as a fact. Review caught it.
- **Lesson:** Scope the domain and presentation changes into the ticket that adds the marker.
- **Action:** none, awareness only

### L-60: Two mappers that register the same agent must agree on `sourceAgentId`
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #23 · **Recorded by:** M2.04 teammate
- **What happened:** The reducer silently ignores a second `agent.registered` that claims an agent ID under a different `sourceAgentId`.
- **Lesson:** Agree on `sourceAgentId`, not only on the envelope `agentId`.
- **Action:** none, awareness only

### L-59: Evidence has to be bound to the recorded hook, not to its key
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #27 · **Recorded by:** M2.06 teammate
- **What happened:** Events omit bodies, so duplicate or partly conflicting retries could carry bodies that were never recorded.
- **Lesson:** Bind evidence to the recorded hook; "every event accepted" closes that class of problem.
- **Action:** none, awareness only

### L-58: `redactJson` masks only strings directly under a sensitive key
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #27 · **Recorded by:** M2.06 teammate
- **What happened:** Nested objects and numbers under `password` or `token` passed through `redactJson` unmasked. That is fixed for evidence. The same gap exists for event payloads at ingest; it was noted for the lead as its own ticket, because fixing it changes dedupe hashes.
- **Lesson:** Check nested values and non-string values under sensitive keys, not only direct string values.
- **Action:** Ingest gap fixed in #200 (M2.17, #194).

### L-57: Masking must run on the whole body before any cut
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #27 · **Recorded by:** M2.06 teammate
- **What happened:** A tempting pre-cut for speed would have split a private key block, leaving a half that is no longer recognizable.
- **Lesson:** Mask the whole body first and cut afterwards. The test for it is a key block longer than the cap.
- **Action:** none, awareness only

### L-56: Widening a lookbehind can make a lookahead quadratic
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #185 · **Recorded by:** M2.14 teammate
- **What happened:** The lookbehind was what kept the OpenAI digit lookahead linear. Widening it made the lookahead quadratic.
- **Lesson:** When the body is greedy over the same character class, check after the match (`accept`) rather than ahead of it.
- **Action:** none, awareness only

### L-55: Check what an unmasked case really is before fixing it
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #185 · **Recorded by:** M2.14 teammate
- **What happened:** The high-entropy rule already masked random tokens after `_`, so the reported gap was narrower than it looked. The failing cases had to use low-entropy bodies and words over 256 characters to show the real gap.
- **Lesson:** Reproduce the gap with the inputs that actually escape the existing rules before writing the fix.
- **Action:** none, awareness only

### L-54: `cmd &` in a non-interactive POSIX shell gets `/dev/null` as stdin
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #20 · **Recorded by:** M2.01 teammate
- **What happened:** A background drain of the script's stdin read `/dev/null` instead.
- **Lesson:** Duplicate the descriptor first (`exec 3<&0`), then run `cat <&3 &`.
- **Action:** none, awareness only

### L-53: Size a concurrency test so that the unlocked version demonstrably fails
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #20 · **Recorded by:** M2.01 teammate
- **What happened:** On macOS a single `cat >>` of 150 KB from 24 concurrent writers did not interleave, so the test passed with no lock at all. It took 900 KB payloads under dash to show the corruption.
- **Lesson:** Choose payload sizes for which the unlocked version demonstrably fails.
- **Action:** none, awareness only

### L-52: A denied permission fires no PostToolUse
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #22 · **Recorded by:** M2.03 teammate
- **What happened:** A hook deny or a terminal "No" fires no PostToolUse, so a running ToolCall with no Post is the normal path for every denial, not a rare race.
- **Lesson:** Treat a ToolCall with no Post as a normal outcome for denials.
- **Action:** none, awareness only

### L-51: Scanning every argument for `test` misreads option values
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #22 · **Recorded by:** M2.03 teammate
- **What happened:** Scanning every argument for `test` misread option values, such as `pnpm -C test build`.
- **Lesson:** Parse the command position, not every argument.
- **Action:** none, awareness only

### L-50: A field with a `masked` flag must reach the engine unmasked
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #22 · **Recorded by:** M2.03 teammate
- **What happened:** Masking a field before ingest hid the engine's masking metadata, so the flag said false for masked text. Cutting such a field could also split a secret or strip the context after it, such as the `@` after a URL password.
- **Lesson:** Send the field unmasked and let the engine mask it. Re-run the redactor on the cut text rather than reasoning about span edges.
- **Action:** none, awareness only

### L-49: Before pushing to an open PR, check that it is still open
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #21 · **Recorded by:** M2.02 teammate
- **What happened:** A PR was merged while follow-up commits were still being pushed to its branch.
- **Lesson:** Before pushing to an open PR's branch, check `gh pr view --json state`. After a merge, cut a new branch from `origin/main` and cherry-pick.
- **Action:** none, awareness only

### L-48: Commit before mutating a file
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #21 · **Recorded by:** M2.02 teammate
- **What happened:** A `sed` mutation on an uncommitted file, followed by `git checkout`, also discarded the real change when the `sed` pattern silently failed to match.
- **Lesson:** Commit before mutating, so that a restore cannot take the real change with it.
- **Action:** none, awareness only

### L-47: A comparison path outside the pipeline needs the pipeline's own guards
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #21 · **Recorded by:** M2.02 teammate
- **What happened:** Hashing new content under a reused key without `textProblem` turned a lone surrogate into a 500 (the same class as L-31).
- **Lesson:** Any comparison that bypasses the pipeline must run the pipeline's input guards too.
- **Action:** none, awareness only

### L-46: Hook payloads have no timestamp, so content hashes must not include engine-clock values
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #21 · **Recorded by:** M2.02 teammate
- **What happened:** `occurredAt` comes from the engine clock, so it landed in the content hash and turned every retry into a conflict. My first fix skipped the comparison, and review caught it as high.
- **Lesson:** Compare content with the transport fields put back, rather than skipping the comparison.
- **Action:** none, awareness only

### L-45: A placeholder mapper is worse than no route
- **Date:** 2026-10-31 · **Milestone:** M2 · **Ticket:** #21 · **Recorded by:** M2.02 teammate
- **What happened:** The shim treats a 200 as delivered. Wiring an incomplete source into `serve` would lose hooks that an unmounted route (a spooled 404) keeps.
- **Lesson:** Do not mount a source route with a placeholder mapper; leave the route unmounted until the real mapper lands.
- **Action:** none, awareness only

### L-44: A read-only review agent cannot post its review or reproduce findings
- **Date:** 2026-10-31 · **Milestone:** M1 · **Ticket:** #17 · **Recorded by:** lead (M1.RT)
- **What happened:** The security reviewer for #17 ran as a read-only agent type whose shell allowed only read-only git, so it could not run `gh issue comment`, the engine tests, or loopback probes. Its findings were code traces, its reply was truncated twice, and the lead posted the review. Each fix PR then reproduced its finding with a failing test first.
- **Lesson:** Decide before a review ticket starts who posts the result and who reproduces findings; a read-only reviewer needs a teammate that can run probes.
- **Action:** Proposed for M2 and M3 in docs/retros/M1.md (change 6).

### L-43: A memory criterion on RSS measures allocator noise at this scale
- **Date:** 2026-10-31 · **Milestone:** M1 · **Ticket:** #103 · **Recorded by:** storage teammate (M1.21)
- **What happened:** SC-006 (RSS growth under 10% from hour 1 to hour 8) missed twice: 14.1% then 26.6% on the same seeded input, while heap retained after GC stayed flat (16.6 to 16.7 MiB). The soak also showed projection state growing linearly (148 KiB calm, 474 KiB lively after 8 hours) because closed requests, terminal tasks and finished subagents are never pruned.
- **Lesson:** Define memory criteria on retained memory (heap after GC) or a long steady-state real-time run; run a realistic soak early, since it finds unbounded state that unit tests never do.
- **Action:** Follow-ups #166 (RSS miss) and #167 (unbounded state); decision #168 (what SC-006 measures).

### L-42: Run the quickstart by hand before the gate
- **Date:** 2026-10-31 · **Milestone:** M1 · **Ticket:** #19 · **Recorded by:** lead
- **What happened:** Running spec 001's quickstart on main found two stale expectations: the status header shows `2 trouble` (heuristic, because fixture timestamps are in the past) where the doc said `0 trouble`, and an unauthenticated POST with no Origin returns `403 forbidden_origin` where the doc said `401`. Everything else matched, including resume at N+1 with no gaps and stable offline hashes.
- **Lesson:** Goldens with injected clocks can hide what a person sees with the real clock; the lead runs the quickstart once per milestone before the gate.
- **Action:** quickstart.md corrected in the same lead PR.

### L-41: Settle regex-semantics review claims with one line of the target runtime
- **Date:** 2026-10-31 · **Milestone:** M1 · **Ticket:** #17 · **Recorded by:** hardening teammate (M1.18 F4, F6)
- **What happened:** roborev (job 4990, medium) claimed the session-ID regex accepts `"s\n"` because `$` matches before a trailing newline. That is PCRE behavior; in JavaScript `/^...$/.test("s\n")` is false, shown with `node -e` and a passing test row.
- **Lesson:** Check a reviewer's language-semantics claim on the actual runtime before fixing, and answer with the evidence. Default expiry clocks to a monotonic source (`performance.now()`) and keep them injectable.
- **Action:** Answered with `roborev respond`; PR #164.

### L-40: Mask to a robust boundary instead of parsing ever more precisely
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #17 · **Recorded by:** hardening teammate (M1.18 F3)
- **What happened:** Fixing two reported credential forms took six roborev rounds and 18 more shapes (12 high findings in total, each fixed test-first); one finding (a space-led quoted Digest value) needed two fixes. Numeric-pair and path exemptions each hid a real password and were removed. A skip-ahead guard added for linear time hid nested input.
- **Lesson:** Masking to a robust boundary (line end, end of the shell word) closes whole classes; every exemption is bypass surface; skip ahead only inside regions already masked; assert exact output when the secret can equal visible text (`admin:admin`).
- **Action:** Fixed in PR #158; strategy question in decision ticket #160.

### L-39: Every parsed number that drives a loop or a clock needs a finiteness check
- **Date:** 2026-10-30 · **Milestone:** M1 · **Ticket:** #18 · **Recorded by:** domain teammate (M1.16)
- **What happened:** A digits-only regex accepted hundreds of 9s, which parse to `Infinity`; review found it three times, one flag at a time (`--duration` medium in job 4957, then custom pace intervals high and `--speed` medium in job 4962). Separately, macOS has no `timeout`, so a red run that could hang was not run, and its empty output was briefly misread as a reproduced hang.
- **Lesson:** Check `Number.isFinite` and an upper bound wherever input becomes a duration, interval or loop count, in the library and not only the CLI; write red tests against parser return values when the failing behavior is a hang.
- **Action:** Fixed in the CLI in PR #156; library parsers bounded (30 days simulated, `MAX_DURATION_MS`) in PR #159.

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
