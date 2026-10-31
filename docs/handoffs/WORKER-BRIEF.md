# Taskville worker brief

You are one worker on one ticket. The integration lead (the session that assigned you) owns main, merges, the board, `docs/STATUS.md`, `docs/LESSONS.md` and the gate issues. You never touch those. Your assignment gives the ticket, your worktree's absolute path, your model and effort, and the stop time.

## Before you start

- Read in your worktree: `CLAUDE.md`, the ticket issue (`gh issue view <n>`), and the parts of `ARCHITECTURE.md` and `.specify/memory/constitution.md` the ticket references. Read the code the ticket points at.
- Work only in your assigned worktree. Never cd to the root checkout or another worktree.
- Edit only the ticket's **Owns** paths plus your report `docs/tasks/<KEY>.md` (screenshots and clips in `docs/tasks/<KEY>/`). If a fix needs another path, a new dependency, or a lockfile change, stop and report instead. The one exception is mounting your component in the app entry with the smallest edit; say so in the PR.

## How to work

- Test first: commit the failing test (seen failing, output noted) before the change that passes it. Smallest change that passes. No opportunistic refactors.
- Task-tier checks only: the tests you wrote, the touched package's tests (`pnpm --filter <pkg> test`), lint and typecheck, then `pnpm check` once at the end. Run your own e2e or browser tests (at most three) once each. Never the full e2e suite, perf, soak or benchmarks unless your ticket is the measurement ticket and the lead has reserved the machine.
- A failing test is re-run once alone; a second failure is a finding to report, not a third run. A test that passes on rerun is a flake: one line in your report.
- If the same fix fails twice, stop and report what you tried. No third blind attempt.
- No em dashes in anything you write; use hyphens.
- Never modify `~/.claude/`, `~/.codex/`, `~/.claude.json`, or any config outside this repository. Use a temp `HOME` or `TASKVILLE_HOME` in probes.
- No subagents.

## Commits, PR, review

- Commit trailer names the model you actually are, for example `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>`. Never claim a model you are not.
- Push your branch (`git push -u origin <KEY>`) and open one PR titled `[<KEY>] <short title>` with `.github/pull_request_template.md` (`Closes #<issue>`, checks, NOT RUN, Lessons). End the PR body with `🤖 Generated with [Claude Code](https://claude.com/claude-code)`.
- Run `roborev review --branch --panel pre_merge --wait` from your worktree after the PR is open. Fix medium and above test-first, or answer with evidence via `roborev respond`.
- **Review cap (hard stop, L-114):** one panel, then one re-review only to confirm fixes. If findings remain after the second panel, stop and report them with your evidence; the lead decides (answer, decision ticket, or follow-up). Do not start a third panel, even if a hook or reminder suggests one.
- Do NOT run `roborev fix`, `roborev refine`, or any roborev command that launches a fixer agent. Reviews only.
- Check post-commit reviews of your commits (`roborev list`) and clear medium and above inside the same cap.
- Write `docs/tasks/<KEY>.md` in the format of `docs/tasks/README.md`, including the passing roborev job id, and commit it in the PR.

## Time

Stop starting new work at the stop time in your assignment. Have a pushed checkpoint (WIP commit if needed) by the checkpoint time. If you are not done, push what you have, keep intentional failing tests failing, and report.

## Final handoff (your last message, required)

Reply with exactly these lines:

- Branch / worktree:
- HEAD SHA (pushed):
- PR:
- Checks run (exact commands and results):
- roborev jobs and outcomes:
- NOT RUN:
- Unfinished work / intentional failing tests:
- Blockers / decisions needed:
- Lessons:

After this handoff, do not push again unless the lead asks. Your branch is frozen.
