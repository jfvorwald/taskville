# Contract: `taskville` CLI (feature 001 subset)

Global options: `--home <dir>` (default `$TASKVILLE_HOME` or `~/.taskville`),
`--url <base>` (default `http://127.0.0.1:4807`), `--json` (machine output).
Human output to stdout, diagnostics to stderr.

| Command | Behavior | Exit codes |
| --- | --- | --- |
| `taskville serve --headless [--port N]` | Runs the engine in the foreground; creates home, DB, token on first run; rebuilds stale projections before listening | 0 on clean shutdown (SIGINT/SIGTERM), 1 on startup failure |
| `taskville status --project <id>` | Prints one line per agent: name, connection, activity, task, attention reason; header shows `N active · M waiting` | 0 ok, 2 unknown project, 3 engine unreachable |
| `taskville events ingest --file <path.jsonl>` | Posts in batches of 1,000; prints counts `accepted / duplicate / conflict / rejected` and each rejection with line number | 0 if none rejected or conflicting, 4 otherwise, 3 unreachable |
| `taskville events follow --project <id> [--after N]` | Streams envelopes; on `resnapshot`, takes a new snapshot and continues; prints the cursor it resumes from | 0 on SIGINT, 3 unreachable |
| `taskville demo start --project <id> --seed <n> [--speed <x>] [--duration <sim-time>]` | Runs the seeded producer against the engine; `--speed` multiplies the virtual clock | 0 when duration ends or SIGINT |
| `taskville demo run --seed <n> --duration <sim-time> --offline` | Runs the scenario through the reducer in-process without an engine and prints the final `stateHash` (determinism check) | 0 |

`--json` output for `status` is the snapshot's agent list plus `cursor` and
`stateHash`, stable enough to diff in tests.
