# Contract: `taskville` CLI (feature 001 subset)

Global options: `--home <dir>` (default `$TASKVILLE_HOME` or `~/.taskville`),
`--url <base>` (default `http://127.0.0.1:4807`), `--json` (machine output).
Human output to stdout, diagnostics to stderr. Every request sends
`Authorization: Bearer <token>` from `<home>/token` ([http-api.md](http-api.md)).

| Command | Behavior | Exit codes |
| --- | --- | --- |
| `taskville serve --headless [--port N]` | Runs the engine in the foreground on `127.0.0.1` (any other host is refused); creates home, DB, token, the built-in Unsorted project on first run; rebuilds stale projections before listening; prints the one-time browser pairing URL `http://127.0.0.1:<port>/#pair=<code>` and that it is valid for 10 minutes | 0 on clean shutdown (SIGINT/SIGTERM), 1 on startup failure |
| `taskville project add --name <name> [--id <id>] [--root <dir>]...` | Adds a project (FR-011) through `POST /v1/projects`; `--root` repeats; relative roots are resolved to absolute paths | 0 ok, 2 project exists, 3 unreachable, 5 auth failure |
| `taskville project list` | One line per project: id, name, roots, head; Unsorted is always listed | 0 ok, 3 unreachable, 5 auth failure |
| `taskville status --project <id> [--all]` | Indented tree (FR-012, below) | 0 ok, 2 unknown project, 3 unreachable, 5 auth failure |
| `taskville events ingest --file <path.jsonl>` | Posts in batches of 1,000; prints counts `accepted / duplicate / conflict / rejected` and each rejection with line number and code (`unknown_project` included) | 0 if none rejected or conflicting, 4 otherwise, 3 unreachable, 5 auth failure |
| `taskville events follow --project <id> [--after N]` | Streams envelopes; on `resnapshot`, takes a new snapshot and continues; prints the cursor it resumes from | 0 on SIGINT, 2 unknown project, 3 unreachable, 5 auth failure |
| `taskville requests [--project <id>] [--all]` | Read-only list of pending requests (FR-018), below | 0 ok, 2 unknown project, 3 unreachable, 5 auth failure |
| `taskville unpair` | Revokes every paired browser session (`POST /v1/pairing/revoke`) and prints the count | 0 ok, 3 unreachable, 5 auth failure |
| `taskville install claude-code --scope user\|project [--project-dir <dir>] [--yes] [--dry-run]` | M2.08. Adds one async command hook (`"async": true`) per ARCHITECTURE.md 8.1 telemetry event (not PermissionRequest, which is M4.04). Each hook points at a copy of the shim in `<home>/hooks/taskville-claude-code-shim.sh`, with `TASKVILLE_HOME` and `TASKVILLE_URL` always set in the command, so values inherited from the environment never win. User scope writes `$CLAUDE_CONFIG_DIR/settings.json` or `$HOME/.claude/settings.json`, following a symlink. Project scope writes `<dir>/.claude/settings.local.json` and refuses symlinks (decision #190). Prints the redacted diff and asks; `--yes` skips the question, and `--dry-run` writes nothing. Idempotent | 0 ok or already installed, 1 refused, declined, or invalid settings |
| `taskville uninstall claude-code --scope user\|project [--project-dir <dir>] [--yes] [--dry-run]` | Removes only the hook entries install wrote, recognized by their exact command. Restores the original byte for byte from `<settings>.taskville-backup` when nothing else changed since install, and otherwise rewrites the file without Taskville's entries. Leaves the shim copy in place | 0 ok or not installed, 1 refused or declined |
| `taskville demo start --project <id> --seed <n> [--pace <pace>] [--speed <x>] [--duration <sim-time>]` | Runs the seeded producer against the engine; `--speed` multiplies the virtual clock | 0 when duration ends or SIGINT, 2 unknown project, 3 unreachable |
| `taskville demo run --seed <n> --duration <sim-time> --offline [--pace <pace>]` | Runs the scenario through the reducer in-process without an engine and prints the final `stateHash` (determinism check) | 0 |

Exit code 5 covers `401` and `403` responses (missing or invalid token, bad Host).

## `status` output

Header: `<project name> · N active · M needs you · T trouble · W waiting`, where
active counts unfinished agents whose activity is neither `idle`, `waiting` nor `unknown` (a fresh session's activity is `unknown` until it reports one), and
the other counts come from the `attention` selector in the snapshot.

Body: an indented tree, two spaces per level (FR-012 clarification):

- Top-level agents (kind `session` or `lead`) at depth 0, ordered by display name,
  together with any agent whose parent or team lead is not in the snapshot.
- A lead's teammates beneath it; every agent's subagents beneath it, recursively.
- Finished subagents (`finishedAt` set) are hidden unless `--all`.
- Each line: display name, kind (when not `session`), connection, activity
  (with `(heuristic)` when flagged), task, and the highest attention record:
  `needs you: <kind> <tool> - <reason>`, `trouble: <kind> - <reason>`, or
  `waiting`. Heuristic attention is labeled, for example `trouble (heuristic):
  quiet for 12 min` or `needs you (heuristic): ...`. A guessed name and kind from a
  heuristic registration (decision #120) is shown after the activity as
  `maybe <name> (<kind>, heuristic)`, never in place of the recorded name. Masked or truncated reasons show a `[masked]` or `[truncated]`
  marker.

`--json` prints `{ "projectId", "cursor", "stateHash", "agents": [...],
"attention": [...] }`: the snapshot's agents sorted by ID (with `kind`,
`parentAgentId`, `teamId`, `finishedAt`), filtered by `--all` the same way,
stable enough to diff in tests.

## `requests` output

Without `--project`, lists every project's requests. One line per request: project,
agent, kind, tool, waiting since, `answerable: yes|no` (yes only for bridge-held
requests, M4), and reason. Only `open` requests unless `--all`. The command reads
the `requests` map from each project's snapshot; there is no separate route.

The CLI never answers a request. It has no flag or subcommand for allow, deny, or
reply, and the engine refuses its token on the command route (ARCHITECTURE.md
section 9.2, constitution principle I exception). The output ends with a hint:
"Answer from the paired browser or in the agent's terminal."

## `--pace` (FR-013)

| Value | Meaning |
| --- | --- |
| `calm` (default) | A visible change every 5 to 15 s and a needs-you moment about every 3 min at 1x |
| `lively` | A visible change every 1 to 3 s at 1x; needs-you moments at least as often as `calm` |
| `change=<min>-<max>,needs-you=<interval>` | Custom, for example `change=2s-6s,needs-you=90s`; durations take `s`, `m`, or `h` |

The same seed and pace always give the same event sequence and `stateHash`.
`--speed` changes only how fast the virtual clock runs, not the sequence.
