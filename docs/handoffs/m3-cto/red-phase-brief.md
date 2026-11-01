# Red phase brief (Taskville M3, test-writer)

You own the red phase of one ticket. The CTO is the top-level session that spawned you; report to it in your final message.

- Repository rules: read CLAUDE.md and the ticket contract in your assignment (pasted there; do not rely on `gh`). Read the task reports in `docs/tasks/` that document the interfaces you test against (M3.02 data store, M3.03 overlay host, M3.04 layout, M3.05 agents, M3.06 movement, M3.07 themes, M3.11 interaction, M3.12 lighting, M3.15 settings).
- Work only in your assigned worktree (absolute path). Use `cd <worktree> && ...` in every shell command. Your base is an integration branch with unmerged M3 work; treat it as given.
- Allowed paths: tests only, under the paths in your assignment (unit tests `apps/web/test/<subpath>/**/*.test.ts`; browser component tests `apps/web/src/<subpath>/**/*.browser.test.tsx` only if the ticket needs a real browser; e2e specs `apps/web/e2e/<name>.spec.ts`). No source, config, lockfile or docs changes. If a test needs a small exported type or seam that does not exist yet, import it from the path the implementer will create and let it fail on the missing module; describe the expected interface in your handoff.
- Commands, run from the worktree root:
  - unit: `pnpm exec vitest run --project @taskville/web apps/web/test/<subpath>`
  - browser: `pnpm --filter @taskville/web test:browser`
  - e2e: `E2E_PORT=<your port> pnpm --filter @taskville/web test:e2e <spec>` (rebuilds; the port is shared otherwise)
- Each test must fail for the right reason (missing module or wrong behavior), never a typo or syntax error. Run each once and keep the failure output.
- Commit only the tests: `git add <test paths> && git commit -m "[<KEY>] Failing tests: <what>"` with trailer `Co-Authored-By: Claude Sonnet 5.5 <noreply@anthropic.com>` (name your actual model), then `git push -u origin <KEY>`. Never force push.
- No em dashes; use hyphens. Never modify user-level config.

Final message, exactly:
- Branch / worktree:
- Red commit SHA (pushed):
- Tests written (file: what each asserts):
- Exact commands to run them:
- Failure output (short, per file):
- Interface the implementer must create (exports, signatures, file paths):
- Paths the implementer may touch (from the ticket Owns):
- Notes / risks:
