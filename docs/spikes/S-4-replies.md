# Spike S-4: typed replies through a Claude Code channel

- **Ticket:** #91 (M8.04) · **Date:** 2026-11-08 · **Run by:** Claude (debugger worker)
- **Versions:** Claude Code 2.1.316, model `claude-haiku-5-5`, Node 26.8.2 (Bun not installed, not needed)
- **References:** ARCHITECTURE.md sections 9.1 to 9.4 and 13; [channels](https://code.claude.com/docs/en/channels), [channels reference](https://code.claude.com/docs/en/channels-reference), [MCP: push messages with channels](https://code.claude.com/docs/en/mcp), [env vars](https://code.claude.com/docs/en/env-vars) (`CLAUDE_CODE_SESSION_ID`), [fakechat source](https://github.com/anthropics/claude-plugins-official/tree/main/external_plugins/fakechat)

## Question

Can a paired browser user type a reply to an agent through a Claude Code channel? How is the target session addressed, what does the user consent to, how and when does the reply arrive, what happens when the session is busy or closed or the channel server is down, and what are the security implications?

## Summary

| Question | Answer | Evidence |
| --- | --- | --- |
| Can a custom Taskville channel register today? | **Only with `--dangerously-load-development-channels`**, which shows a full-screen warning in an interactive session at every launch and is ignored with `-p` and the Agent SDK. `--channels` accepts only Anthropic's allowlist (`claude-plugins-official`) or a Team or Enterprise org's `allowedChannelPlugins`. | Docs; run 1 (flag ignored headless, both events dropped) |
| Which session receives a message? | The one that spawned the channel server. Each session starts its own stdio server; there is no cross-session routing. | Docs; run 1 |
| How would Taskville know the target? | The server's environment has `CLAUDE_CODE_SESSION_ID`, equal to the hooks' `session_id`, and its parent pid is the `claude` process, the same parent as hook commands. After `/clear`, or on `--continue`, the server keeps its startup ID (docs). | Run 1 |
| Sender allowlist | Implemented entirely inside the channel server. Claude Code trusts whatever the server emits. | Docs; gate test |
| Consent | Per session, at launch (the flag), plus the development warning. No per-message approval in Claude Code. The reply tool follows normal permission rules. | Docs |
| How does a reply arrive? | As `<channel source="taskville" key="value">text</channel>` in Claude's context; the terminal shows `← taskville: text`. **Not verified live.** | Docs |
| Session busy | Queued in order, delivered together on the next turn. **Not verified live.** | Docs |
| Session closed | The server gets SIGINT and exits with the session, so its port is gone (connection refused). | Run 1 debug log; gate test |
| Delivery confirmation | **None.** A notification resolves once written to stdio, and is dropped silently if the channel is not registered. | Docs; run 1 |
| Local injection | Any unauthenticated loopback port is reachable: a desktop app on this machine connected to every new loopback listener within about 0.5 s. | Probe check |

## What was tried

Throwaway directory `/tmp/s4-spike` (`proj` git repo with one README, `server` for scripts, `logs` mode 0700). Session-scoped settings only: `--settings proj/settings.json --setting-sources project,local`, `--mcp-config proj/mcp.json --strict-mcp-config`. Nothing under `~/.claude` was edited.

1. **Prototype** `taskville-channel.mjs`: a dependency-free stdio MCP server (newline-delimited JSON-RPC). It declares `experimental['claude/channel']` and `tools` (one `reply` tool), and deliberately not `claude/channel/permission`. It answers `initialize` with protocol `2025-06-18` (legacy era; on the v2 runtime a server that negotiates 2026-07-28 does not register as a channel). Inbound HTTP on `127.0.0.1:<random port>`, `POST /reply`, gated on: `Host` equal to `127.0.0.1:<port>`, a bearer token (32 random bytes, endpoint file mode 0600, compared in constant time), a sender allowlist, an 8 KiB body cap and a 2000-character text cap. In self-test mode it emits a channel event 500 ms after `notifications/initialized` and on every `tools/call` (during a turn).
2. **Gate test** without Claude Code (`gate-test.mjs` drives the server over stdio):

   | Case | HTTP | Events emitted |
   | --- | --- | --- |
   | no token | 401 | 0 |
   | wrong token | 401 | 0 |
   | `Host: evil.example:<port>` (DNS rebinding) | 403 | 0 |
   | sender not on allowlist | 403 | 0 |
   | authorized | 202 | 1 |
   | after stdin closed (session gone) | ECONNREFUSED | 0 |

3. **Live run 1** (headless, the only Claude Code run):

   ```sh
   claude -p "Call the taskville reply tool once with reply_id p1 and text pong. Then answer in one line: did any <channel> tagged message appear in your context? If yes, quote it exactly; if no, say NO-CHANNEL." \
     --model claude-haiku-5-5 --max-turns 3 \
     --settings /tmp/s4-spike/proj/settings.json --setting-sources project,local \
     --mcp-config /tmp/s4-spike/proj/mcp.json --strict-mcp-config \
     --dangerously-load-development-channels server:taskville \
     --output-format stream-json --verbose --debug-file /tmp/s4-spike/logs/debug-run1.txt
   ```

   Result: `success`, 3 turns, $0.0024, answer `NO-CHANNEL`. The server logged both events written to stdout (`21:37:30.159Z` after init, `21:37:33.197Z` during the `reply` call). The debug log has no channel line at all: the flag is ignored silently in `-p`. The server connected in 221 ms (`protocolEra: legacy`). Before `initialize`, Claude Code sent a `server/discover` probe, then initialized with `protocolVersion: 2025-11-25`. The `reply` tool call worked as an ordinary MCP tool (found through ToolSearch). At exit: `Sending SIGINT to MCP server process`, `exited cleanly`.

4. **Probe check:** a fresh loopback listener logging the peer through `lsof` was hit by `GET /` with `Host: localhost:<port>` from the T3 Code desktop app within about 0.5 s. The same probe appears in the prototype's logs (`bad host`, denied) in both the gate test and run 1.

**NOT RUN:** an interactive session with the development flag. Channels are a research preview, custom channels need the flag, and the flag needs a human to accept a full-screen warning. The brief said to stop the live part in that case, and an agent accepting a "dangerously" dialog through tmux keystrokes would be consenting for the owner. Rows marked "not verified live" rely on the docs.

## Findings

### 1. Availability

During the research preview `--channels` registers only allowlisted plugins. A Taskville plugin, even from its own marketplace, needs `--dangerously-load-development-channels plugin:taskville@<marketplace>`. The docs say the flag works only interactively and shows a full-screen warning; run 1 confirmed it is silently ignored headless. Pro, Max and Ultra users skip org policy but not the preview allowlist. Team and Enterprise admins could list Taskville in `allowedChannelPlugins`. Every user would have to launch every session with a "dangerously" flag, which conflicts with section 13's posture.

### 2. Addressing

There is one server process per session, and the session is the server's parent. The server learns its session from `CLAUDE_CODE_SESSION_ID` (`0a3b6af7-...` in run 1, equal to the SessionStart and UserPromptSubmit hook `session_id`) and its process from `ppid` (40154, equal to the hook commands' `$PPID`; `CLAUDE_PID` is also set). Drift: per the docs, after `/clear` hooks get a new ID while the server keeps its startup ID, and on `--continue` the server may get the startup ID. A durable join key is therefore the `claude` pid plus its start time, which needs the telemetry shim to report its parent pid. A subagent never receives a message: the event goes to the main conversation. Agent-team teammates differ by mode: in-process teammates share the lead's process and session ID (S-2), so a pid-based join cannot address them separately and a reply would reach the lead; split-pane teammates are separate `claude` processes, presumably launched without the flag (not tested).

### 3. Allowlist and consent

Claude Code's controls are the per-session opt-in (`--channels` or the development flag), org policy, and "a `.mcp.json` entry alone cannot push". Who may send is entirely the server's job. Telegram and Discord pair a platform user ID. Fakechat, the official localhost browser demo, has "no tokens, no access control": a fixed port 8787, no Host or Origin check, a multipart `POST /upload` that any web page can send cross-origin, and an open WebSocket. Taskville must not copy it. There is no per-message approval inside Claude Code, so consent per message is the act of sending from an authenticated Taskville UI.

### 4. How replies arrive

From the docs, not verified live: content becomes the body of a `<channel>` tag; `meta` keys become attributes (identifier characters only, others silently dropped); the terminal shows a one-line `←` summary; the server's `instructions` string is given to Claude at connect. The webhook example shows Claude starting to respond on its own, so an idle session appears to wake up. Whether this counts as a user turn, and whether it fires `UserPromptSubmit`, is unknown.

### 5. Busy, closed, server down

- **Busy:** events queue and arrive together on the next turn (docs). Behavior while a permission dialog is open is unknown.
- **Closed:** the server dies with the session (run 1); new connections are refused (gate test).
- **Server down or not registered:** Claude Code drops events silently and returns no error. There is no acknowledgement in any case, so Taskville can only report "queued, not confirmed", the same as section 9.1's "sent, unconfirmed".

### 6. Security

- **Other local processes:** a listening channel port is reachable by any local process and by browsers (simple cross-origin POSTs, DNS rebinding). One was observed probing within 0.5 s. The prototype's Host check, token and allowlist blocked every bad case. Better: the channel server should open no port and dial out to the engine instead.
- **The agent replying to itself:** the supervised agent runs as the same OS user, so it can read token files and reach any local port. If a reply route accepted CLI, hook, bridge or channel tokens, the agent could pass instructions off as user-authored. So `reply.send` must be paired-browser-only, the same rule as `permission.decide` (9.2).
- **Prompt injection:** a reply is by design an instruction with the user's authority, equal to typing in the terminal (the terminal shows it). Risks are a non-owner sender (pairing handles it), the UI prefilling or quoting agent-supplied text (forbidden), and markup inside the content: whether `</channel>` is escaped is unknown, so strip `<`, `>`, control and bidirectional-override characters, and bound the length.
- **Permission relay:** do not declare `claude/channel/permission`. It would add a second approval path, outside section 9.2's single audited one, that anyone on the allowlist could use.
- **Inherited credentials:** the server's environment contained `CLAUDE_CODE_MESSAGING_SOCKET` and `CLAUDE_CODE_MESSAGING_TOKEN` (names only were logged). The channel plugin must not use them; 9.4 already excludes the inbox socket. This run was launched from inside another Claude Code session, so whether the values were the child's own was not checked.
- **Audit:** Claude Code records the message in the session transcript; Taskville should record its own command event (below).

## Recommendation

**No-go for this release.** Revisit when a Taskville plugin can be enabled with `--channels` without the development flag, and the owner-run check below passes. Reasons: the "dangerously" flag at every launch, interactive-only, unconfirmed delivery, and unverified delivery semantics. Alternative for the owner at G8: build it as an explicitly experimental opt-in behind the flag. Not recommended, for the posture reason above.

### Smallest viable design (if go)

- **Plugin `taskville` channel server with no listening port.** At start it reads `$TASKVILLE_HOME/channel-token` (0600; a new token class that can neither authorize commands nor send replies), opens `GET /v1/channels/stream` to the engine with `{session_id, claude_pid, cwd}`, emits each pushed reply as a channel event, and acks the engine once it is written. Declares `claude/channel` and no permission capability; never negotiates protocol 2026-07-28.
- **Endpoints:** `POST /v1/commands {type: "reply.send", session_id, text, in_reply_to?, idempotency_key}`, accepted only from a paired browser session (`X-Taskville-Session` plus Origin). CLI, hook, bridge and channel tokens are rejected. Live context only; history is rejected. The target must have a connected stream. SSE back to the web client: `reply.queued` or `reply.undeliverable`.
- **Engine rules:** text at most 2000 characters, control, bidi and angle-bracket characters stripped, content only; fixed `meta` (`reply_id`, `sender=taskville-user`); idempotency key per send; never prefilled from agent text; join on `claude_pid` when the session ID has drifted.
- **Consent UI:** a reply box only on agents whose session has a live channel; it names the session and cwd and says "This is sent to the agent as an instruction, as if typed in its terminal". No bulk or reply-to-all. Status stays "queued, not confirmed" until the session's next telemetry.
- **Audit:** a `reply.sent` event with pairing ID, session ID, a bounded excerpt and SHA-256 of the text, the idempotency key, and the outcome (queued, no channel, channel closed).
- **ARCHITECTURE 9.4 would need** (owner's call): the availability and launch requirement; the outbound transport and channel token (also section 13); `reply.send` in 9.2's command list with the paired-browser rule; the audit event in 9.3; non-confirmation semantics as in 9.1; no permission relay; the inbox socket exclusion kept.

### Owner-run check (about 5 minutes, interactive)

Start the session in tmux and accept the warning. While idle, POST a reply using `/tmp/s4-spike/logs/endpoint-<pid>.json`. Repeat during a long `sleep` in Bash, while a permission dialog is open, and after `/clear`. Record the terminal view and whether `UserPromptSubmit` fires.

```sh
claude --dangerously-load-development-channels server:taskville --model claude-haiku-5-5 \
  --mcp-config /tmp/s4-spike/proj/mcp.json --strict-mcp-config \
  --settings /tmp/s4-spike/proj/settings.json --setting-sources project,local
```

## Open risks

- Research preview: flag syntax and protocol may change.
- Delivery semantics (user turn or not, busy, permission dialog open) not verified live.
- Session ID drift after `/clear` and `--continue`.
- Subagents cannot be addressed; teammates are probably launched without the flag.
- Escaping of `</channel>` inside content is unknown.
- No delivery acknowledgement from Claude Code.
- Same-user threat model limit (section 13): any same-user process can read token files.
- The v2 MCP runtime refuses to register a channel that negotiates 2026-07-28.

## Redaction

No tokens are recorded here (the prototype token exists only in a 0600 file under `/tmp`). The session ID is a random UUID. Paths are `/tmp`. Evidence logs stayed in `/tmp/s4-spike` and are not committed.
