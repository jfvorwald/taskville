# Hook shim and OTel helper: security notes

The general security model is in ARCHITECTURE.md section 13 (owner-gated, not edited here). This file records the limits specific to the Claude Code hook shim (`hooks/claude-code-shim.sh`) and the OpenTelemetry headers helper (`hooks/claude-code-otel-headers.sh`).

## Live engine rule (M7.30, #434)

The shim posts the CLI token and the unredacted hook payload, and the helper prints the token, only when `$TASKVILLE_HOME/engine.json` (written by `taskville serve`) exists as a regular file, its `url` equals the target origin (`TASKVILLE_URL` with trailing slashes stripped) and its `pid` is alive (`kill -0`). Otherwise the shim spools the event without contacting the port, and the helper prints nothing and exits 0.

This closes the case where the engine has exited and some other process took its port: a stale or missing `engine.json` no longer lets that process receive the token or the payloads.

## Remaining limit: same machine, same user

The check proves that the engine we started is alive, not that the process listening on the port is that engine. These remain possible:

- If the engine dies without removing `engine.json` (a crash or kill) and an unrelated process later reuses its pid, the record looks live. If that machine also has a process on the engine's port, it receives the token.
- A process of the same OS user can write its own `engine.json` (naming a live pid such as its own) and listen on the target port. The shim and helper run as that user and trust the same files they read the token from, so they cannot tell it from the engine.

Anything running as the same user can already read `$TASKVILLE_HOME/token` directly, so this rule narrows accidental and stale-port exposure; it is not a defense against a hostile same-user process. Defending against that would need the engine to authenticate itself to the shim, which is a design decision for the owner.
