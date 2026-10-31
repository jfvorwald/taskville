# Claude Code telemetry, end to end (M2.10)

This checks ARCHITECTURE.md 14, M2 "done when", against real Claude Code sessions:

- Sessions, subagents and teammates appear in `taskville status` with correct parents within a second.
- ToolCalls are recorded, with masked evidence in `evidence.db`.
- Engine downtime loses nothing: the spool replays as late, and never opens needs-you.

This is push tier. It is not part of `pnpm check`.

## Replay (no model, a few seconds per scenario)

```sh
node --test tests/e2e/claude-code-telemetry/
```

`replay.test.ts` pipes each recorded hook in `fixtures/` through the real shim (`apps/cli/hooks/claude-code-shim.sh`) into a real `taskville serve --headless` in a temporary home. It then checks `taskville status --json`, the event log in `taskville.db`, and `evidence.db`. The downtime scenario SIGKILLs the engine after the PostToolUse of `echo step1`, keeps feeding hooks so the shim spools them, and restarts the engine on the same home.

## Live (real model, small spend)

```sh
node tests/e2e/claude-code-telemetry/live.ts --out <scratch dir> [--model claude-haiku-5-5] [--only subagents,downtime,team,stop-failure,elicitation]
node tests/e2e/claude-code-telemetry/redact.ts --out <same dir>    # refresh fixtures/
```

`live.ts` needs `claude` (2.1.312 recorded), `tmux` and `python3` on PATH, and a logged-in Claude Code. Everything goes under `--out`:

- a throwaway git project;
- a `TASKVILLE_HOME`;
- `taskville serve` run from this checkout;
- `taskville install claude-code --scope project` into the throwaway project only;
- a synchronous recorder hook in the project's `.claude/settings.json`;
- a stdio MCP server (`elicit-server.mjs`) in its `.mcp.json`.

Every `claude` run uses a clean environment and `--setting-sources project,local`. Nothing under `~/.claude` is written. The one side effect outside `--out` is the folder-trust entry that the interactive team run's trust dialog adds to `~/.claude.json`.

`live.ts` writes:

- `report.txt`: hook counts, how long each agent took to reach the snapshot, `taskville status --all`, tool call and evidence counts, and the downtime results;
- `raw/<scenario>.jsonl`;
- `status-*.json`;
- `team-pane.txt`.

`redact.ts` rewrites paths, user and host names, and the seeded token. It refuses to write a fixture that still holds any of them.

| Scenario | How | What it records |
| --- | --- | --- |
| `subagents` | `claude -p` | Two parallel subagents, Bash/Read/Edit, a seeded token in tool output, TaskCreate and TaskUpdate (TaskCreated, TaskCompleted), a failing Bash (PostToolUseFailure) |
| `downtime` | `claude -p` | The engine is SIGKILLed after `echo step1`; the session keeps running and spools; the engine restarts after it |
| `team` | interactive, private tmux server, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, in-process | One teammate `pip`, a shared task, shutdown |
| `stop-failure` | `claude -p --model claude-nonexistent-0-0` | StopFailure (`error: model_not_found`) |
| `elicitation` | `claude -p`, stdio MCP server, `--permission-prompts none` | Elicitation |

Recorded output of the run behind the committed fixtures: [`live-output/report.txt`](live-output/report.txt).

Fixture line format, as in `fixtures/claude-code/*`: `{"seq", "offset_ms", "input"}`. Here `input` is the raw hook JSON, and `offset_ms` is the time the synchronous recorder received the hook, relative to the first line.
