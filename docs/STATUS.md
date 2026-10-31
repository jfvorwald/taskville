# Status

Lead-owned cross-session summary. Teammates never edit this file; they write their own report in [tasks/](tasks/) and the lead folds it in here after review and merge.

**Updated:** 2026-10-30 · **Current wave:** 1 (M1 Headless foundation) · **Open gate:** [G1 #19](https://github.com/jfvorwald/taskville/issues/19)

## Where things stand

The pnpm workspace and quality gate are in (PR #108): `pnpm check` runs typecheck, lint and tests in under a second, and CI runs it on every PR and push to main. Spec 001 is aligned with architecture revision 3 (PR #112), so its contracts are now the source for the code tickets. Both spikes are still running; batch 2 has started with the engine HTTP core and protocol v1.

## In progress

| Ticket | Lane | Teammate | State |
| --- | --- | --- | --- |
| [#3](https://github.com/jfvorwald/taskville/issues/3) M1.03 Spike S-1 permission hook | Research | research-s1 | in progress |
| [#4](https://github.com/jfvorwald/taskville/issues/4) M1.04 Spike S-2 crews attribution | Research | research-s2 | in progress |
| [#7](https://github.com/jfvorwald/taskville/issues/7) M1.10 Engine HTTP core, auth, pairing | Engine | engine | in progress |
| [#5](https://github.com/jfvorwald/taskville/issues/5) M1.05 Protocol v1 schemas | Domain | domain | in progress |

Ready, waiting for a free teammate: #24 M1.20 (P0), #6 M1.06, #8 M1.11, #94 M1.19.

## Done this wave

| Ticket | PR | roborev | Checks |
| --- | --- | --- | --- |
| [#1](https://github.com/jfvorwald/taskville/issues/1) M1.01 Align spec 001 with architecture | [#112](https://github.com/jfvorwald/taskville/pull/112) | job 4675: 2 high fixed; re-review 4684: 1 medium fixed; background reviews of fix commits pass | Done-when grep passes; side-by-side table in [report](tasks/M1.01.md); `pnpm check` 6/6 |
| [#2](https://github.com/jfvorwald/taskville/issues/2) M1.02 Scaffold workspace, quality gate, CI | [#108](https://github.com/jfvorwald/taskville/pull/108) | pass, job 4668, no findings | `pnpm check` 6/6 locally, on a clean clone and in CI ([report](tasks/M1.02.md)) |

## Waiting on the owner

Open decision tickets: [label `waiting:user`](https://github.com/jfvorwald/taskville/issues?q=is%3Aopen+label%3Awaiting%3Auser).

- [#110](https://github.com/jfvorwald/taskville/issues/110) where projects are registered (default: engine `projects` table, `project add` via `POST /v1/projects`, config projects registered at start). Blocks nothing.
- [#114](https://github.com/jfvorwald/taskville/issues/114) ARCHITECTURE.md 7.4 vs 6 on `pending_requests`/`commands` tables (default: projection-only, M4; text unchanged). Blocks nothing.

 Items there are blocking only if the ticket says so; everything else proceeds on its stated default.

## Measurements

| What | Value | Command | Ticket |
| --- | --- | --- | --- |
| `.claude/check.sh` wall time, clean clone | 0.72 s | `time ./.claude/check.sh` (macOS, Node 26.8.2, pnpm 12.4.2) | #2 |

Targets in the spec are not measurements until a ticket records them here with the command that produced them.

## Known follow-ups

- #12 (M1.17): quickstart now expects `invalid.jsonl` to include an `unknown_project` line.
- Spec 001 defaults where the architecture gives none: silent-trouble threshold 10 min, `inputPreview` 2,000 chars, input reason 4,000 chars before truncation, custom `--pace` syntax (see [M1.01 report](tasks/M1.01.md)).

- Nothing yet enforces that `packages/protocol`, `domain` and `adapters` import no Node built-ins (one shared tsconfig with `types: ["node"]`). Owning tickets (#5, #6, #24) add a package-local test for it.
- Packages still carry M1.02 placeholder tests; owning tickets remove them when real tests land.

## Next

Merge the spikes as they land, then fill free slots from Ready by priority: #24, then #6, #8, #94. See [ROADMAP.md](ROADMAP.md).
