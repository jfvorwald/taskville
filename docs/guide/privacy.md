# Privacy

Taskville is local and single user. It has no account, no cloud service, and no staging or hosted version.

## What is recorded, and where

- Claude Code hooks send each hook's raw JSON to the engine on `127.0.0.1`. Nothing leaves your machine.
- The engine stores events in a SQLite log under your Taskville home (`~/.taskville` by default). Tool inputs and outputs are kept as bounded excerpts, not whole files.
- Credentials and sensitive environment values are stripped when the engine ingests an event, before it is written to the event log.
- If the engine is down, the hook writes the raw event to a spool file in the home folder (readable only by your user) and the engine redacts it when it reads the spool on its next start. Until then the spool can hold unredacted secrets, so treat the home folder as private.

## Who can reach the engine

- The engine listens on `127.0.0.1` only, and rejects requests with any other `Host` header.
- The CLI and the hook shim use a token in `<home>/token`, readable only by your user (mode 0600).
- Browsers must be paired (see [pairing and answering prompts](pairing-and-prompts.md)). Paired browsers are stored as SHA-256 digests, not as plain secrets.
- Other programs running as your user can already read your files and edit Claude Code settings. Taskville does not protect against that.

## Hiding code

Code is visible only in the agent panel (the Live and Files tabs). The city itself never shows code.

To hide code bodies, turn on **Hide code in the city** in the settings panel. Taskville keeps file names and edit counts and hides the code itself in the Live and Files tabs. A permission action card still shows the exact tool input it asks about, which can include code or other sensitive text, so close or answer cards before you share your screen. It is off by default, and the setting is remembered in the browser.

## Removing what Taskville recorded

- Stop the engine with Ctrl-C.
- Delete the Taskville home folder (`~/.taskville`, or the `--home` folder you used) to remove the event log, pairings, and token. This is not reversible.
- Run `taskville uninstall claude-code` for the scope you installed to remove the hooks.
