# Troubleshooting

Start with:

```sh
taskville doctor
```

It prints one line per check, `ok` or `fail`, and a `fix:` line under each failure. Run `taskville doctor --json` for the same checks as JSON. The exit code is nonzero when any check fails. Pass `--home <dir>` or `--url <base>` if you use a non-default home or engine address.

Each check, with its fix:

| Check | Fails with | Fix |
| --- | --- | --- |
| `node` | `Node <version> is outside <range>` | Install Node 26.8.x, for example `nvm install 26`, then run `pnpm bootstrap` again. |
| `web` | `web client is not built` | Run `pnpm bootstrap`, or `pnpm --filter @taskville/web build` from the checkout. |
| `engine` | `no engine is running` or `no answer from <url>` | Run `taskville start`. Use the same `--home` as the engine. |
| `engine` | `the engine at <url> rejected the token in <home>` | Run `taskville start` with the same `--home` as the running engine. Doctor reads the token from that home. |
| `hooks` | `no Claude Code hooks point at <home> and <url>` | Run `taskville init` in the repository, or `taskville install claude-code --scope user` (or `--scope project`). |
| `shim` | `<path> is missing` or `is not executable` | Run `taskville install claude-code --scope user` again. |
| `curl` | `curl is not on PATH` | Install `curl` with your package manager. The hook shim needs it. |
| `project` | `this folder is not in any project` | Run `taskville init` in the repository. Doctor finds project hooks from any subfolder. |
| `project` | `could not list projects` | Run `taskville start`, then check the engine check. |

## Other problems

- **The browser says the link is used or expired.** Press `p` in the engine's terminal for a new link, or restart `taskville start`.
- **The city is empty.** Run `taskville demo` to see agents, or `taskville init` in your repository and then start a Claude Code session there.
- **`start` says the web client is not built** and this is not a checkout. Reinstall, or point `TASKVILLE_WEB_DIR` at a folder with a built `index.html`.
- **`start` says a build failed.** Read the last lines it prints. Fix the reported error, then run `pnpm bootstrap` again.
- **`start` says `Taskville is already running at <url>`.** Use that engine, or stop it (Ctrl-C in its terminal) before starting another.
- **`start` says another `taskville start` holds the lock.** Wait a few seconds and try again. If it persists, check that no other `start` is running for the same home.
- **Port in use.** Use `taskville start --port <N>` with a free port, and open that port's URL.
- **An agent does not show up.** Confirm `taskville doctor` passes, that the repository is in a project, and that the session started after the hooks were installed.
- **Prompts do not appear in the city.** Check the `hooks` and `engine` checks. Without a paired browser, Taskville shows the agent as needing you but cannot answer it; use the terminal.
- **Something else.** Run `taskville doctor --json` and include its output in an issue.
