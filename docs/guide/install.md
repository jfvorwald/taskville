# Install and first run

## Requirements

- Node 26.8.x
- pnpm 12
- `curl` on your PATH (the Claude Code hook shim uses it)
- A Git repository you want to watch, and Claude Code if you want live agents

Taskville runs on your machine only. Nothing is hosted, and there is no installer yet.

## 1. Bootstrap

From a checkout of this repository:

```sh
pnpm bootstrap
```

Bootstrap checks Node and pnpm, installs dependencies, builds the web client, and offers a `taskville` command. The web build runs quietly; if it fails, bootstrap prints the last 30 lines of its output.

If you decline the `taskville` command, you can still run every command as `pnpm taskville <command>` from the checkout.

## 2. Start the engine and pair your browser

```sh
taskville start      # or: pnpm taskville start
```

`start` runs the engine in the foreground and opens your browser to a one-time pairing link. See [pairing and answering prompts](pairing-and-prompts.md). Use `--no-open` to print the link without opening a browser, or `--port N` for another port. Press Ctrl-C to stop the engine.

If an engine is already running for the same home, `start` says so and does not start a second one.

## 3. Add your repository

In a Git repository you want to watch:

```sh
taskville init
```

`init` adds the repository as a project (once; running it again says it is already set up) and offers the Claude Code hooks for that project. Answer `y` to install them, or pass `--yes` to skip the question. Pass `--no-hooks` to add the project without touching Claude Code settings. Pass `--name <name>` to choose the project name.

`init` writes project hooks to `.claude/settings.local.json`, which holds machine-specific paths. Add that file to `.gitignore` if your repository does not ignore it already.

To install the hooks later, or at user scope for every project:

```sh
taskville install claude-code --scope project
taskville install claude-code --scope user
```

### Let the browser answer prompts

Telemetry works as soon as the hooks are in. To answer Claude Code's permission prompts from the browser, Claude Code also needs the bridge token, passed for that launch only:

```sh
env TASKVILLE_BRIDGE_TOKEN="$(cat ~/.taskville/bridge-token)" claude
```

Without it, prompts still appear in the terminal as usual. `init` prints this line with your real token path.

### Installing hooks by hand

Both commands show the exact settings change and ask before writing. Add `--dry-run` to look without writing. To remove Taskville's entries again:

```sh
taskville uninstall claude-code --scope user
```

Uninstall removes only Taskville's entries. Use the same `--scope` you installed with, and `--project-dir <dir>` for a project scope outside the current folder.

## 4. See the city without a real session

```sh
taskville demo
```

`demo` plays a seeded crew of six agents with no flags needed. It is the quickest way to check that the browser and engine work.

## Checking the setup

```sh
taskville doctor
```

Doctor prints one line per check and a `fix:` line for each failure. The checks, and what to do about each, are in [troubleshooting](troubleshooting.md).

## Where Taskville keeps its state

Everything lives in `~/.taskville` by default: the event log, the pairing records, and the CLI token (mode 0600). Override it with `--home <dir>` after any command (for example `taskville doctor --home /tmp/tv`; options before the command name are not accepted), or with the `TASKVILLE_HOME` environment variable. Use the same home for `start`, `init`, `install`, and `doctor`, or they will not find each other.

## Updating and removing

- After you pull new code, run `pnpm bootstrap` again. It is safe to repeat.
- To stop Claude Code telemetry for a repository, run `taskville uninstall claude-code --scope project` in it. The engine still watches the repository's Git activity while the project is registered, and there is no command to remove a project yet.
- To remove Taskville's hooks from user settings, run `taskville uninstall claude-code --scope user`.
