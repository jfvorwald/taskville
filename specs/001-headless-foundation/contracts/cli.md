# Contract: `taskville` CLI (feature 001 subset)

Global options: `--home <dir>` (default `$TASKVILLE_HOME` or `~/.taskville`),
`--url <base>`, `--json` (machine output). The URL is resolved in order: `--url`,
`$TASKVILLE_URL`, the `url` in `<home>/engine.json` (M7.08) when it is an `http:` URL on
exactly `127.0.0.1` or `localhost` with an explicit port and no userinfo, and its `pid` is
alive (`process.kill(pid, 0)`; EPERM counts as alive; the pid must be a positive integer up to 2147483647, since 0 and negatives signal whole process groups), then `http://127.0.0.1:4807`. A missing,
malformed, stale or non-loopback `engine.json` is ignored silently. Only the URL's origin is used. A stale file left by a crash whose pid was reused looks live, so commands fail with the unreachable error naming that URL. An unreachable engine exits 3
and the message names the base URL and `taskville start`. `--url` and `$TASKVILLE_URL` must be `http://127.0.0.1:<port>` or `http://localhost:<port>` (no userinfo, path or query); anything else exits 1 before any request, so the CLI token is never sent off the machine (M7.10). Under `pnpm taskville`, the working directory is `$INIT_CWD` (the folder pnpm was run from) when the process runs in the checkout root; elsewhere `INIT_CWD` is ignored.
Human output to stdout, diagnostics to stderr. Every request sends
`Authorization: Bearer <token>` from `<home>/token` ([http-api.md](http-api.md)).

| Command | Behavior | Exit codes |
| --- | --- | --- |
| `taskville start [--port N] [--no-open] [--verbose]` | M7.08. The engine in the foreground for a person at a terminal; same engine as `serve --headless`. Builds the web client once (one "Building..." line) when it is missing and the CLI runs from a source checkout, and otherwise fails with one sentence mentioning the web client. Opens the one-time pairing URL in the default browser when stdout is a terminal (not with `--no-open`; the link is printed if the browser cannot be opened). Console output is a short banner (URL, home, how to pair again, Ctrl-C) and plain-sentence warnings; JSON log lines go to `<home>/logs/engine.log` (file 0600, folder 0700), and `--verbose` also prints them to stderr. If `<home>/engine.json` names a live engine (pid alive and `/health` answers), prints its URL and "press p" for a new link and exits without starting another. A port in use fails with one sentence naming the port and `--port` | 0 on clean shutdown or when an engine is already running, 1 on startup failure |
| `taskville serve --headless [--port N] [--verbose]` | Runs the engine in the foreground on `127.0.0.1` (any other host is refused); creates home, DB, token, the built-in Unsorted project on first run; rebuilds stale projections before listening; prints the one-time browser pairing URL `http://127.0.0.1:<port>/#pair=<code>` and that it is valid for 10 minutes. Without a terminal on stdout, JSON log lines go to stderr; on a terminal it is quiet like `start` (log file, `--verbose`). Writes `<home>/engine.json` (`{url, pid, startedAt}`, 0600) once listening and removes it on clean shutdown, as `start` does. Reports a live engine instead of starting a second one | 0 on clean shutdown (SIGINT/SIGTERM), 1 on startup failure |
| `taskville project add --name <name> [--id <id>] [--root <dir>]...` | Adds a project (FR-011) through `POST /v1/projects`; `--root` repeats; relative roots are resolved to absolute paths | 0 ok, 2 project exists, 3 unreachable, 5 auth failure |
| `taskville project list` | One line per project: id, name, roots, head; Unsorted is always listed | 0 ok, 3 unreachable, 5 auth failure |
| `taskville status --project <id> [--all]` | Indented tree (FR-012, below) | 0 ok, 2 unknown project, 3 unreachable, 5 auth failure |
| `taskville events ingest --file <path.jsonl>` | Posts in batches of 1,000; prints counts `accepted / duplicate / conflict / rejected` and each rejection with line number and code (`unknown_project` included) | 0 if none rejected or conflicting, 4 otherwise, 3 unreachable, 5 auth failure |
| `taskville events follow --project <id> [--after N]` | Streams envelopes; on `resnapshot`, takes a new snapshot and continues; prints the cursor it resumes from | 0 on SIGINT, 2 unknown project, 3 unreachable, 5 auth failure |
| `taskville requests [--project <id>] [--all]` | Read-only list of pending requests (FR-018), below | 0 ok, 2 unknown project, 3 unreachable, 5 auth failure |
| `taskville unpair` | Revokes every paired browser session (`POST /v1/pairing/revoke`) and prints the count | 0 ok, 3 unreachable, 5 auth failure |
| `taskville install claude-code --scope user\|project [--project-dir <dir>] [--yes] [--dry-run]` | M2.08. Adds one async command hook (`"async": true`) per ARCHITECTURE.md 8.1 telemetry event (not PermissionRequest, which is M4.04). Each hook points at a copy of the shim in `<home>/hooks/taskville-claude-code-shim.sh`, with `TASKVILLE_HOME` and `TASKVILLE_URL` always set in the command, so values inherited from the environment never win. User scope writes `$CLAUDE_CONFIG_DIR/settings.json` or `$HOME/.claude/settings.json`, following a symlink. Project scope writes `<dir>/.claude/settings.local.json` and refuses symlinks (decision #190). Prints the redacted diff and asks; `--yes` skips the question, and `--dry-run` writes nothing. Idempotent | 0 ok or already installed, 1 refused, declined, or invalid settings |
| `taskville uninstall claude-code --scope user\|project [--project-dir <dir>] [--yes] [--dry-run]` | Removes only the hook entries install wrote, recognized by their exact command. Restores the original byte for byte from `<settings>.taskville-backup` when nothing else changed since install, and otherwise rewrites the file without Taskville's entries. Leaves the shim copy in place | 0 ok or not installed, 1 refused or declined |
| `taskville init [--name <name>] [--yes] [--no-hooks]` | M7.10. In a Git repository: adds the Git top-level (real path) as a project, named after the folder unless `--name`, with an ID from the name that gets `-2`, `-3` on a clash. Idempotent: a repository already listed prints "already set up". Then offers the project-scope `install claude-code` flow (diff shown, one question; `--yes` skips it, `--no-hooks` skips the offer). Declining, or no terminal without `--yes`, exits 0 with the command to install later | 0 ok, 1 not a Git repository, 3 unreachable or 5 auth failure (points at `taskville start`) |
| `taskville doctor` | M7.10. One line per check, `<ok\|warn\|fail> <id>: <message>`, with ` fix: <command>` on a failure; ids in order `node`, `web`, `engine`, `hooks`, `shim`, `curl`, `project`. `--json` prints `[{id,status,message,fix?}]`. Hooks pass when user or project settings name this home and engine URL | 0 no check failed, 1 any failed |
| `taskville demo [start] [--project <id>] [--seed <n>] [--pace <pace>] [--speed <x>] [--duration <sim-time>]` | Runs the seeded producer against the engine; `--speed` multiplies the virtual clock. `--project` defaults to `unsorted`; `--seed` defaults to a random safe integer, printed as `Demo seed <n>` (batches carry sourceId `demo:<seed>`, so the printed seed reproduces the run). `demo` alone or with only options runs `demo start`; an unknown subcommand exits 1 | 0 when duration ends or SIGINT, 2 unknown project, 3 unreachable |
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

With `--all`, one line follows the tree for each of finished agents and terminal tasks
that projection retention dropped (`retired`, data-model.md "Retention", decision #202
D2), only when its count is above zero, for example `12 older finished agents are in the
event log` or `1 older finished task is in the event log`. Without `--all`, or when the
counts are zero, there is no such line.

`--json` prints `{ "projectId", "cursor", "stateHash", "agents": [...],
"attention": [...] }`: the snapshot's agents sorted by ID (with `kind`,
`parentAgentId`, `teamId`, `finishedAt`), filtered by `--all` the same way,
stable enough to diff in tests. With `--all` it also carries `"retired": { "agents",
"tasks", "requests" }`, the snapshot's counts.

## `requests` output

Without `--project`, lists every project's requests. One line per request: project,
agent, kind, tool, waiting since, `answerable: yes|no` (yes only for bridge-held
requests, M4), and reason. Only `open` requests unless `--all`. The command reads
the `requests` map from each project's snapshot; there is no separate route.

With `--all`, a line `N older closed requests are in the event log` (singular `1 older
closed request is in the event log`) follows the rows, before the hint, when the
`retired.requests` count, summed over the listed projects, is above zero. `--json` prints
`{ "requests": [...] }`, and with `--all` also `"retired": { "agents", "tasks", "requests" }`
summed over the listed projects.

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
