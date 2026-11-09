# Hook shim and OTel helper: security notes

The general security model is in ARCHITECTURE.md section 13 (owner-gated, not edited here). This file records the limits specific to the Claude Code hook shim (`hooks/claude-code-shim.sh`) and the OpenTelemetry headers helper (`hooks/claude-code-otel-headers.sh`).

## Live engine rule (M7.30, #434)

The shim posts the CLI token and the unredacted hook payload, and the helper prints the token, only when `$TASKVILLE_HOME/engine.json` (written by `taskville serve`) exists as a regular file, its `url` equals the target origin (`TASKVILLE_URL` with trailing slashes stripped) and its `pid` is alive (`kill -0`). Otherwise the shim spools the event without contacting the port, and the helper prints nothing and exits 0.

The host `localhost` is treated as `127.0.0.1` in both the target origin and the recorded `url`; no other host is rewritten. The recorded `pid` must be 1 to 7 digits (some shells truncate an oversized pid to 0, and `kill 0` would signal the caller's process group).

This closes the case where the engine has exited and some other process took its port: a stale or missing `engine.json` no longer lets that process receive the token or the payloads.

## Remaining limit: same machine, same user

The check proves that the engine we started is alive, not that the process listening on the port is that engine. These remain possible:

- If the engine dies without removing `engine.json` (a crash or kill) and a process of the same user reuses the recorded pid, the record looks live (other users' pids fail `kill -0` with EPERM). If that machine also has a process on the engine's port, it receives the token.
- The engine can exit in the few milliseconds between the liveness check and the POST. This window is accepted.
- A process of the same OS user can write its own `engine.json` (naming a live pid such as its own) and listen on the target port. The shim and helper run as that user and trust the same files they read the token from, so they cannot tell it from the engine.

## OTel helper output is cached

Claude Code caches the helper's output and refreshes it periodically (debounced); it does not re-run the helper for every export. Two consequences:

- A header printed while the engine was live can keep being sent after the engine stops, until the next refresh. The token then goes to whatever listens on the port in that window.
- A helper run while the engine is down prints no header, so exports get 401 and metrics are lost until the next refresh.

Anything running as the same user can already read `$TASKVILLE_HOME/token` directly, so this rule narrows accidental and stale-port exposure; it is not a defense against a hostile same-user process. Defending against that would need the engine to authenticate itself to the shim, which is a design decision for the owner.

## Codex permission forwarder (A1.02)

`hooks/codex-permission-bridge.sh` is the command hook Codex runs for PermissionRequest. It applies the live engine rule above, then posts the hook body and the bridge token (`$TASKVILLE_HOME/bridge-token`) to `/v1/bridge/codex/permission` and prints the engine's answer to Codex, which acts on it.

A fake listener has the same standing as for the shim: a process of the same user that writes its own `engine.json` (naming a live pid such as its own) and listens on the target port receives the bridge token and the request, and could answer with an allow. The forwarder cannot tell it from the engine, so such a listener could forge an allow for a tool call. Defending against that would need the engine to authenticate itself to the forwarder, which is a design decision for the owner.

What the forwarder does now limit is the shape of the answer. It prints only the exact bodies the engine writes: the allow literal, or a deny whose only content is a message of bounded size (compact JSON, `hookEventName` `PermissionRequest`, no other key). Anything else (`updatedInput`, an `interrupt` flag, extra keys, another event name, an oversized message, text that is not JSON) prints nothing, so Codex shows its own prompt. A listener that is not the engine therefore cannot rewrite a tool call or end a turn through the answer, only allow or deny it.

Its temporary directory is `$TASKVILLE_HOME/.codex-permission.XXXXXX` (0700, removed on exit). The engine removes ones older than a minute that a killed hook left, when it replays the spool at start.
