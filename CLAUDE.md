# Taskville: rules for Claude Code sessions and agent teams

Read [ARCHITECTURE.md](ARCHITECTURE.md), the [constitution](.specify/memory/constitution.md), and [docs/ROADMAP.md](docs/ROADMAP.md) before working. GitHub issues on the [project board](https://github.com/users/jfvorwald/projects/2) are the work items; each issue's Owns, Blocked by, Scope, and Done when sections are the contract.

## Run to the gate

Work proceeds without waiting on the owner until a review gate (`[G1]` to `[G8]`, label `gate`). Gates are the only planned stops. Agents never close gates.

Everything else that needs the owner becomes a **decision ticket**, not a stop:

- Open an issue from the Decision template (labels `type:decision` and `waiting:user`): numbered choices, each with a default and an alternative, what happens meanwhile, and exactly what it blocks.
- Keep working on the default. Label only the tickets that truly cannot proceed `needs:decision` (and `blocked`), and link the decision ticket from them.
- When the owner answers, apply it, comment what changed, and close the decision ticket. If an answer is ambiguous, open a follow-up decision ticket rather than guessing.
- Always stop and ask (decision ticket plus a pause of the affected work) for: changes to ARCHITECTURE.md or the constitution, scope changes, conflicts between tickets, anything touching production, and anything touching the user's own config outside this repository.

## Review with roborev

Every ticket branch is reviewed with roborev before merge:

```sh
roborev review --branch --panel pre_merge --wait   # bug + security reviewers
```

Fix findings at medium severity and above, or reply to a finding with evidence that it is wrong (`roborev respond`). Re-review once after fixes; if the same finding survives two fix attempts, stop and open a decision ticket or hand it to the debugger. Record the passing roborev job in the task report. The post-commit hook also reviews individual commits in the background; clear its medium and above findings before merge.

## Status

- Teammates write `docs/tasks/<KEY>.md` (format in [docs/tasks/README.md](docs/tasks/README.md)) in their own PR and never edit shared status files.
- The team lead alone updates [docs/STATUS.md](docs/STATUS.md), [docs/LESSONS.md](docs/LESSONS.md), and the board's Status field, after each merge.
- At a gate, the lead posts the summary on the gate issue (retro link first), adds `waiting:user` to the gate issue, updates STATUS, and stops.

## Working rules

- Test first. Smallest change that passes. Touch only the ticket's Owns paths.
- Task-tier checks per ticket: the tests you wrote, the touched packages' tests, lint, typecheck, then `pnpm check` once. The full suite runs once per wave, never per ticket.
- One PR per ticket, titled with the ticket key, using the PR template (`Closes #<issue>`, Lessons section).
- Spikes use throwaway projects and project-scoped settings only. Never modify `~/.claude/settings.json` or other user-level config. Redact fixtures before committing.
- Never deploy to production. Staging only, and only in M7.
- No em dashes in anything written; use hyphens.
