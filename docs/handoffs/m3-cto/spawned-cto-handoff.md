# M3 CTO handoff (spawned cto teammate, 2026-10-31 ~20:30 EDT)

Written on the lead's recovery request. Updated global rule (~/.claude/CLAUDE.md, changed during this run): the CTO is the top-level session, never a spawned teammate. This teammate is therefore being retired; the lead adopts the CTO role in place.

## Workers
None running. All four spawned reviewers finished and returned their reports (summarized below). No children to collect or transfer.

## What changed on GitHub and in git
- Issue #230 created: [M3.17] cross-ticket wiring (settings to theme, lighting, reduced motion; selector to overlay host selection; live relabel; `?theme=`). Milestone M3, labels enhancement + lane:web-ui, added to project board. Blocked by #36 #37 #38 #39 #44.
- Comment on #47: M3.16 smoke also waits for #230.
- Comment on #48 (G3): #230 joins the gate's list. The gate body "Waits for" line was NOT edited; the lead may add #230 there.
- New branch pushed: `lead/m3-integration-2` (worktree /Users/jfvorwald/dev/taskville/.worktrees/lead-int2), HEAD 6ea33b3 = origin/lead/m3-integration 87691b5 + merges of M3.06 78bb6c6, M3.11 fadcc18, M3.15 866d753, M3.12 7717a75 (M3.12 brings M3.07 81f7258). Integration base only, not for merge.
  - Conflicts resolved (mechanical, mount lines only):
    - apps/web/e2e/engine.ts: codes file keeps paired, fresh, interaction, home.
    - apps/web/src/city/index.tsx: ThemedCity, DayNightLighting (must stay after ThemedCity), CityAgents, InteractionLayer.
    - apps/web/src/overlays/index.tsx: registry counts-header, agent-labels, camera-controls, settings-panel (all ENABLED); useDataSync("unsorted") plus useSelection() (M3.11 replaces the useState selection).
  - Checks on 6ea33b3, run once: `pnpm run typecheck` pass; `pnpm exec biome check apps/web` pass; `pnpm --filter @taskville/web test` 38 files / 267 tests pass; `pnpm --filter @taskville/web build` pass. Output: scratchpad/int2-check.txt. NOT RUN: pnpm check (full root), e2e, test:browser.
  - Use: base for M3.17 (all its blockers are in it) and for M3.13 / M3.14 (M3.06 is in it). Later rebase each ticket's own commits with `git rebase --onto origin/main 6ea33b3` onto a new `-r` branch.

## Review results (batch 1)
Reviewer limitation, important: the code-reviewer and security-reviewer agents' guard hook allows only read-only git. They could not run vitest, typecheck, biome or `gh`. Every verdict below is a static read. The lead must run each ticket's checks itself and paste the issue contract into reviewer prompts (they cannot `gh issue view`). Update the review brief accordingly.

| Ticket | Reviewer | Verdict | Must fix (medium+) |
| --- | --- | --- | --- |
| M3.01 #26 PR #229 | code-reviewer | PASS (7 low) | none |
| M3.01 #26 PR #229 | security-reviewer | PASS (4 low) | none |
| M3.02 #30 | code-reviewer | PASS conditional (7 low) | none; conditions: run its tests and typecheck; record the package.json dependency follow-up |
| M3.02 #30 | security-reviewer | CHANGES REQUESTED | [medium] apps/web/src/data/sync.ts:85 reconnect storm: `attempt = 0` resets on stream open before any event applies, so open-then-close or repeated resnapshot retries at 0 ms. Fix: reset only after one applied event (or open > ~10 s); test: three immediate closes, sleep delays grow. |

M3.01: CI checks `check` and `web-smoke` pass (gh pr checks 229). With both reviews PASS and roborev already passed, M3.01 is merge-ready; still BLOCKED only by the rulesets (owner decision pending).

M3.02 next step: on branch `M3.02-r` (after M3.01 merges, `git rebase --onto origin/main a50a46d`), test-writer writes the storm test (red), implementer fixes sync.ts (green), one code-reviewer confirm, then roborev panel.

Low findings worth follow-up tickets (not fixed, CTO's call):
- M3.02: no heartbeat watchdog (half-open stays `live`; both reviewers flag it, constitution IV); SSE buffer cap and CR/LF chunk split; `redirect: "error"` on fetches (custom session header survives cross-origin redirect); 403 as fatal (needs a SyncError variant = store interface change); abort check before store writes; snapshot projectId and stateHash not verified; react.ts untested.
- M3.02: declare @taskville/domain and @taskville/protocol in apps/web/package.json (lead shared-file PR, lockfile); domain package exports only ./hash, ./reducer, ./reducer/attention, ./selectors subpaths.
- M3.01: dev proxy rewrites any Origin to the engine origin (dev only; rewrite only the dev server's own origin); static stream re-opens by path after O_NOFOLLOW check (keep handle); no CSP on .svg; smoke lacks console/pageerror assertion; test:browser runs nowhere in CI; e2e codes file under Playwright outputDir.

## Check command error in my review brief
`pnpm --filter @taskville/web exec vitest run --root ../.. --project @taskville/web apps/web/test/data` exits 1 with no tests matched (the path filter is resolved from apps/web). This is a command error, not a test failure; M3.02's tests are therefore NOT RUN by me. Use from the worktree root: `pnpm exec vitest run --project @taskville/web apps/web/test/data`. Output: scratchpad/m302-tests.txt.

## Not started (plan for the lead)
- Review batch 2: M3.03 (a50a46d..024fd84), M3.04 (a50a46d..3e176d0), M3.05 (a50a46d..7a04f52), M3.07 (87691b5..81f7258), code-reviewer each.
- Batch 3: M3.15 (87691b5..866d753, code + security), M3.08/09/10 (81f7258..head).
- Batch 4: M3.06 (87691b5..78bb6c6), M3.11 (87691b5..fadcc18, code + security for the URL-triggered `?tv-fixture=agents` and `window.__tvProbe`, reviewed together with M3.06's `?debug=movement` hook), M3.12 (81f7258..7717a75). Handoff points from the CEO messages: test-first slips in M3.06 wiring.test.ts and M3.12 skyColors; edits outside Owns as declared; M3.11 finding that SceneRoot onCreated `camera.lookAt(0,0,0)` overrides CityCamera's target (0,1.5,0), about 21 px projection error affecting M3.03 anchors (needs a fix ticket or a fix in the M3.17 SceneRoot edit); M3.06 `unsorted` project default (decision ticket candidate).
- M3.17 #230, M3.13 #45, M3.14 #46: test-writer then implementer from `lead/m3-integration-2` 6ea33b3. M3.16 #47 after M3.17 green, measurement with the machine reserved.
- Rebase prediction for M3.02 to M3.05 onto main after M3.01 squash: clean (no file overlap with M3.01's post-a50a46d fixes).

## Needs from the owner (unchanged)
1. Merge decision on rulesets 26292100 / 26292102 (merge by hand vs relax). Never --admin.
2. A reserved-machine window for M3.16's measurement.

Files: plan /private/tmp/claude-502/-Users-jfvorwald-dev-taskville/df7347af-36ed-45a0-8fed-a25c42210aa1/scratchpad/m3-cto-plan.md, review brief .../scratchpad/review-brief.md (fix its test command and its "you may run" section before reuse).
