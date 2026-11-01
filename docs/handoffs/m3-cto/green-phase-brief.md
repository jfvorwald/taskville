# Green phase brief (Taskville M3, implementer)

You own the green phase of one ticket. The CTO is the top-level session that spawned you; report to it in your final message.

- Read CLAUDE.md, the ticket contract in your assignment, the failing tests named there (they are the spec), and the task reports in `docs/tasks/` for interfaces you build on.
- Work only in your assigned worktree (absolute path); `cd <worktree> && ...` in every shell command. Add commits only; never rewrite history or force push.
- Allowed paths: the source paths in your assignment only. Never edit tests (a hook blocks it); if a test looks wrong, stop and report why. No config, lockfile or dependency changes; if one is needed, stop and report.
- Run the failing tests first and confirm they fail for the stated reason. Then make the smallest change that passes. Then run, once each: the ticket's tests; `pnpm exec tsc --noEmit -p apps/web/tsconfig.json`; `pnpm exec biome check <your paths>`; `pnpm --filter @taskville/web test`; and `pnpm check > /tmp/<KEY>-check.log 2>&1; grep -nE "FAIL|✗|×" /tmp/<KEY>-check.log` (re-run only named failing files once, alone; a pass on rerun is a flake, log it). Run any e2e spec the ticket names once with `E2E_PORT=<your port> pnpm --filter @taskville/web test:e2e <spec>`.
- Commit with a message `[<KEY>] <what>` and trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (name your actual model), then `git push`.
- If the same fix fails twice, stop and report what you ruled out.
- No em dashes; use hyphens. Never modify user-level config.

Final message, exactly:
- Branch / worktree:
- Green commit SHA (pushed):
- Files changed:
- Commands run and results (actual output lines):
- NOT RUN:
- Flakes:
- Out-of-scope issues noticed (not fixed):
- Blockers:
