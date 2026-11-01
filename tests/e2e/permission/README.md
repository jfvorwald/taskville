# Permission prompts, end to end (M4.10)

This checks ARCHITECTURE.md 14, M4 "done when", for the permission path: a Claude Code permission
prompt turns the agent red, Allow once from the card lets the tool run, Deny blocks it, with no
viewer the terminal prompt appears, and a double click answers once.

Push tier. It is not part of `pnpm check`. There is no package script for it (the root
`package.json` is outside this ticket's paths), so run the commands below.

## Replay (no model, no `claude`, about a minute)

`permission.spec.ts` starts a real `taskville serve --headless` in a throwaway home with
`bridge.holdWindowSeconds` set to 3, pairs a real Chromium to the built web client, and acts as
Claude Code: it posts the recorded spike S-1 `PermissionRequest` payload
(`fixtures/claude-code/permission/permission-request.json`, `cwd` pointed at the throwaway
project) to `/v1/bridge/claude-code/permission` with the bridge token and keeps the connection
open. Each test gets its own engine and its own pairing code.

```sh
cd <repo root>
pnpm --filter @taskville/web exec vite build
pnpm --filter @taskville/web exec playwright test -c ../../tests/e2e/permission/playwright.config.ts
```

The session runs in a folder no project covers, so the engine files it under `unsorted`, the project
the client shows until the viewer picks another.

| Test | Asserts |
| --- | --- |
| held request | the agent turns red, the card opens with the exact input, nothing is decided yet |
| Allow once | the held hook gets the `response-allow.json` body; the card says "Sent, unconfirmed"; one `command.delivered` |
| Deny with a note | the held hook gets a deny whose `message` is the note (shape of `response-deny.json`) |
| no viewer | the hook gets an empty 2xx at once; `request.opened` is recorded; no command, no resolution |
| viewer, no answer | after the window the hook gets an empty 2xx; the card stops offering Allow and Deny (decision #271 D2); no command |
| double click | one `permission.decide` command, one `command.delivered`, one hook answer |

The action card is addressed only through the markers pinned in
`apps/web/src/overlays/action-card/ActionCard.browser.test.tsx` (M4.07): `data-testid="action-card"`,
`data-state`, `data-variant`, `action-card-input`, the buttons "Allow once", "Deny", "Open session",
and the note textbox.

## Live (real model, interactive `claude`): NOT RUN

`live.ts` is ready but has not been run. Decision #289 (D1) defers it until the owner chooses.

A permission dialog only appears in an interactive `claude` session, and an interactive session in a
new folder shows the folder-trust dialog. Accepting it writes a trust entry for the throwaway
project folder into `~/.claude.json`, which is outside this repository. The M2.10 live run had the
same side effect (`tests/e2e/claude-code-telemetry/README.md`). The owner's options in #289:

- Default: do not run it live in M4. The G4 summary lists it as NOT RUN.
- Alternative A: allow the live run to add one folder-trust entry for a throwaway project under a
  scratch directory to `~/.claude.json`, run it once, and remove nothing else.
- Alternative B: run with an isolated `CLAUDE_CONFIG_DIR` and an API key provided through a secret
  prompt, so nothing under the home directory changes. (`live.ts` does not set `CLAUDE_CONFIG_DIR`
  today; add it to `claudeEnv()` if B is chosen.)

Command, once the owner chooses:

```sh
pnpm --filter @taskville/web build
node tests/e2e/permission/live.ts --out <scratch dir> [--model claude-haiku-5-5] [--only allow,deny,terminal]
```

Needs `claude`, `tmux` and `git` on PATH and a logged-in Claude Code. Everything goes under `--out`:
a throwaway git project, a `TASKVILLE_HOME`, `taskville serve` run from this checkout,
`taskville install claude-code --scope project` into the throwaway project only, and the pane
captures (`pane-<scenario>.txt`) and `report.txt`. `claude` runs in a private tmux server
(`tmux -L taskville-permission-e2e`) with `--setting-sources project,local` and a clean environment.

| Scenario | Viewer | Checks |
| --- | --- | --- |
| `allow` | paired browser | the agent turns red; the card shows the command; Allow once; the card says "Sent, unconfirmed"; the file the command creates exists |
| `deny` | paired browser | Deny with a note; the file does not exist; the note shows in the pane |
| `terminal` | none (browser closed) | the terminal dialog appears; answering Yes there runs the command |
