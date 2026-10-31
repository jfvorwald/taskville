# Spike S-1: Claude Code PermissionRequest hook behavior

- **Ticket:** #3 (M1.03) · **Date:** 2026-10-30 (UTC 2026-10-31) · **Run by:** Claude (research teammate)
- **Claude Code version:** 2.1.312, interactive terminal UI inside tmux, model `claude-haiku-5-5`
- **Permission mode:** default (the UI now labels it "manual mode"; hook payloads still say `"permission_mode": "default"`)
- **References:** ARCHITECTURE.md sections 8.1 and 9; [hooks reference](https://code.claude.com/docs/en/hooks)

## Summary

| Question | Answer |
| --- | --- |
| Is the terminal prompt shown while the hook is pending? | **Yes.** The dialog appears at the same moment the hook request is sent and stays answerable for the whole hold. |
| How is a terminal answer reported? Is the hook request cancelled? | **Yes in the terminal: not cancelled.** The HTTP request stays open until the hook `timeout`, and the only signal is the `PostToolUse` that follows once the tool finishes. **No in the terminal: cancelled at once.** Claude Code closes the connection within about 15 ms, and no other hook fires. |
| Does an empty 2xx fall through cleanly? | **Yes.** The dialog stays up unchanged and works normally. |
| Hook timeout? | Claude Code closes the connection at exactly `timeout` seconds, logs "Hook cancelled", and leaves the dialog up. Nothing is shown in the transcript. |
| Connection refused? | Non-blocking. The dialog appears immediately. Unlike the other hook events, a failed PermissionRequest hook prints nothing in the transcript. |
| Does `deny` with a message reach the model? | **Yes, verbatim**, as the tool error. The model quoted it word for word. |
| Hook answers after a terminal answer? | **Silently ignored.** The HTTP write succeeds (the socket is still open), so the sender cannot tell. |
| `Notification` `permission_prompt` | Fires 6.0 s after the dialog appears, **even while the hook is still holding**. It does not fire if the hook or the user answers within those 6 s. |

**Recommendation (owner decides at G1):** keep the hold window independent of whether a viewer is focused, and keep the default at **90 s** with the hook `timeout` at hold + 5 s. The architecture's fallback ("drop to a few seconds unless a viewer is focused") only applied if the terminal prompt were suppressed, and it is not. See [Recommendation](#recommendation-hold-window) for the tradeoff and the three engine rules this spike adds.

## Setup

- Throwaway git repo with two files, outside the Taskville checkout. Session-scoped settings only: `claude --settings <file> --setting-sources project,local --permission-mode default`, so user-level hooks and settings were not loaded and nothing under `~/.claude` was edited.
- Hook config: [hook-settings.json](../../fixtures/claude-code/permission/hook-settings.json). `PermissionRequest` is an `http` hook with `timeout: 20` and a bearer header interpolated through `allowedEnvVars`. `Notification`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `PostToolUseFailure`, `PermissionDenied`, `Stop`, and `StopFailure` also post to the same server so ordering is visible. The last four were added in session 2 only.
- Spike server: [spike-server.mjs](../../fixtures/claude-code/permission/spike-server.mjs), listening on 127.0.0.1:47801. It logs every request, response, and early client close to JSONL, and can be switched at runtime between allow, deny with a message, empty 2xx, never answer, and stopped.
- Each experiment asked the model to run one `touch expN.txt` with the Bash tool, which always needs permission in default mode.
- Evidence: full server log [server-log.jsonl](../../fixtures/claude-code/permission/server-log.jsonl); timestamped pane captures [terminal-panes.txt](../../fixtures/claude-code/permission/terminal-panes.txt) and [terminal-pane-exp1-after-timeout.txt](../../fixtures/claude-code/permission/terminal-pane-exp1-after-timeout.txt); Claude Code debug log hook lines [claude-debug-hook-lines.txt](../../fixtures/claude-code/permission/claude-debug-hook-lines.txt). All timestamps are UTC, from the server clock or Claude Code's debug log on the same machine.

## Payloads

[permission-request.json](../../fixtures/claude-code/permission/permission-request.json) (redacted):

```json
{
  "session_id": "eaff5d10-...",
  "transcript_path": "/Users/dev/.claude/projects/-tmp-spike-s1-proj/eaff5d10-....jsonl",
  "cwd": "/tmp/spike-s1/proj",
  "scratchpad_dir": "/tmp/claude/-tmp-spike-s1-proj/eaff5d10-.../scratchpad",
  "prompt_id": "03dc4896-8835-47f5-a515-94a1ad4c675c",
  "permission_mode": "default",
  "effort": { "level": "medium" },
  "hook_event_name": "PermissionRequest",
  "tool_name": "Bash",
  "tool_input": { "command": "touch exp1.txt", "description": "Create empty file exp1.txt" },
  "permission_suggestions": [
    { "type": "addDirectories", "directories": ["/tmp/spike-s1/proj"], "destination": "session" },
    { "type": "setMode", "mode": "acceptEdits", "destination": "session" }
  ]
}
```

- Headers: `content-type: application/json`, `user-agent: axios/1.15.2`, `connection: keep-alive`, and `authorization: Bearer <token>`. The header was interpolated from the environment because the variable was listed in `allowedEnvVars`.
- There is **no `tool_use_id`** (the docs say the same). `prompt_id` is present and is shared with the `Notification` and `PostToolUse` for the same call, so the engine can correlate on `session_id` + `prompt_id` + `tool_name` + `tool_input`. Two identical calls in one prompt would be ambiguous; this was not tested.
- Fields not in ARCHITECTURE section 8.1's list: `prompt_id`, `scratchpad_dir`, `effort`.

[notification-permission-prompt.json](../../fixtures/claude-code/permission/notification-permission-prompt.json): `hook_event_name: "Notification"`, `message: "Claude needs your permission"`, `notification_type: "permission_prompt"`, same `session_id` and `prompt_id`. No `title`, no `permission_mode`, and nothing that names the tool.

[post-tool-use-after-terminal-allow.json](../../fixtures/claude-code/permission/post-tool-use-after-terminal-allow.json): carries `tool_use_id`, `tool_input` identical to the PermissionRequest's, `tool_response`, and `duration_ms`.

Hook responses that worked: [response-allow.json](../../fixtures/claude-code/permission/response-allow.json) and [response-deny.json](../../fixtures/claude-code/permission/response-deny.json), the shapes in ARCHITECTURE section 8.1.

## Experiments and evidence

Section numbers are for reading; the `expN` labels match the markers in `terminal-panes.txt` and the files the model created. Request numbers (`id`) refer to `server-log.jsonl`.

### 1. Hook never answers, nobody answers: timeout (exp1)

Server in `hang` mode, hook `timeout: 20`.

| Time (UTC) | Event |
| --- | --- |
| 01:16:38.999 | PermissionRequest received (id 2) |
| 01:16:45.016 | Notification `permission_prompt` (id 3), +6.02 s, hook still held |
| 01:16:59.004 | Claude Code closes the connection (`client_closed_before_answer`, id 2), +20.005 s. Debug log: `Hook PermissionRequest:Bash (PermissionRequest) cancelled: Hook cancelled` |
| 01:17:25 | Answered `1. Yes` in the terminal; PostToolUse (id 4) at 01:17:26.105, `exp1.txt` created |

The pane showed the full Bash dialog throughout, including after the timeout ([terminal-pane-exp1-after-timeout.txt](../../fixtures/claude-code/permission/terminal-pane-exp1-after-timeout.txt)). Nothing about the timeout appeared in the transcript.

**Finding:** the dialog is not suppressed while the hook holds, and a hook timeout falls through to the dialog with no visible trace.

### 2. Terminal Yes while the hook holds (exp2, exp8)

| Run | Hook sent | Terminal Yes | PostToolUse | Connection closed |
| --- | --- | --- | --- | --- |
| exp2 (session 1, id 7) | 01:17:43.369 | 01:17:45.565 | 01:17:45.617 | 01:18:03.374 (+20.005 s, at `timeout`) |
| exp8 (session 2, id 29) | 01:21:19.390 | 01:21:22.523 | 01:21:22.752 | 01:21:39.391 (+20.001 s, at `timeout`) |

Debug log for exp2: `tool_dispatch_start tool=Bash ... permissionDecisionMs=2220`. Pane after the answer: `Bash(touch exp2.txt)` then `Done`.

**Finding:** a terminal Yes does **not** cancel the hook request. It stays open until the hook `timeout`. No hook event marks the decision itself; the first signal is `PostToolUse`, which arrives only when the tool finishes (about 50 ms here, but as long as the command runs in general).

### 3. Hook answers after a terminal Yes (exp3)

Server set to deny after 6 s; terminal Yes after 2 s.

| Time (UTC) | Event |
| --- | --- |
| 01:18:23.513 | PermissionRequest (id 11) |
| 01:18:25.723 | Terminal Yes |
| 01:18:25.774 | PostToolUse (id 12), tool ran |
| 01:18:29.514 | Server writes the deny, HTTP 200 accepted by the socket (id 11) |

No debug line after the deny, no change in the pane, and `exp3.txt` exists.

**Finding:** a late hook answer is silently discarded, and the engine's write succeeds anyway. "The decision reached a still-open hook response" is therefore not proof that it took effect.

### 4. Hook allows while the dialog is showing (exp4)

Allow after 4 s, no terminal input. PermissionRequest 01:18:47.325 (id 15), allow sent 01:18:51.328, PostToolUse 01:18:51.383 (+55 ms). The dialog closed and the transcript read:

```
⏺ Bash(touch exp4.txt)
  ⎿  Done
  ⎿  Allowed by PermissionRequest hook
```

No `permission_prompt` Notification fired, because the hook answered inside 6 s.

### 5. Hook denies with a message (exp5)

Deny after 3 s with message `TASKVILLE-SPIKE-DENY-7Q: the owner said no, do not retry`. PermissionRequest 01:19:42.286 (id 19), deny sent 01:19:45.289. Debug log: `Hook PermissionRequest (...) returned permissionDecision: deny`, then `Bash tool permission denied`. Pane:

```
⏺ Bash(touch exp5.txt)
  ⎿  Error: TASKVILLE-SPIKE-DENY-7Q: the owner said no, do not retry
  ⎿  Denied by PermissionRequest hook
⏺ The Bash call for touch exp5.txt was denied. The denial reason, verbatim, is:
  TASKVILLE-SPIKE-DENY-7Q: the owner said no, do not retry
  I've stopped and won't retry.
```

**Finding:** the message reaches the model verbatim as the tool error, and the turn continues (no interrupt). No `PostToolUse` fired. `PostToolUseFailure` and `PermissionDenied` were not configured in that session, so whether they fire on a hook deny was **not tested**.

### 6. Empty 2xx (exp6)

Empty 200 after 3 s. PermissionRequest 01:20:11.096 (id 22), empty response 01:20:14.097. Debug log: `HTTP hook returned empty body, treating as empty JSON object`. The dialog stayed up unchanged, and the Notification `permission_prompt` still fired at 01:20:17.112 (id 23, +6.02 s). Answering `4. No` in the terminal afterwards produced `Interrupted · What should Claude do instead?` and no further hook events (no Stop).

**Finding:** an empty 2xx falls through cleanly.

### 7. Terminal No while the hook holds (exp7)

Session 2, with `PostToolUseFailure`, `PermissionDenied`, `StopFailure`, and `UserPromptSubmit` hooks added. PermissionRequest 01:21:01.785 (id 26), terminal `4. No` at 01:21:04.558, **connection closed 01:21:04.573** (+15 ms after the keypress). No other hook fired: no `PermissionDenied`, `PostToolUseFailure`, `Stop`, or `StopFailure`. Pane: `Interrupted · What should Claude do instead?`.

**Finding:** a terminal No cancels the hook request at once (Esc was not tested; it shows the same "Esc to cancel" path and is expected but not confirmed to behave the same). The early socket close is the engine's only signal for it.

### 8. Server not running: connection refused (exp9)

Server stopped. PermissionRequest POST at 01:22:03.394, `connect ECONNREFUSED` at 01:22:03.407 (13 ms), dialog shown, Notification attempted at 01:22:09.405 (+6.01 s, also refused). Terminal Yes then ran the tool. The transcript showed errors for every other http hook but **not** for PermissionRequest or Notification:

```
❯ Use the Bash tool to run exactly: touch exp9.txt
  ⎿  UserPromptSubmit hook error
  ⎿  connect ECONNREFUSED 127.0.0.1:47801
⏺ Bash(touch exp9.txt)
  ⎿  PreToolUse:Bash hook error
  ⎿  connect ECONNREFUSED 127.0.0.1:47801
  ⎿  Done
  ⎿  PostToolUse:Bash hook error
  ⎿  connect ECONNREFUSED 127.0.0.1:47801
```

**Finding:** with only the PermissionRequest hook configured as `http` (telemetry is async command hooks per ARCHITECTURE section 8.1), Taskville being down is invisible to the user. Configuring any other event as an `http` hook would print an error on every prompt or tool call while Taskville is down, so this supports the architecture's choice.

### Notification timing

The `permission_prompt` Notification fired 6.016 s (exp1), 6.016 s (exp6), and 6.011 s (exp9, connection refused) after the PermissionRequest POST, and not at all when the hook (exp4) or the user (exp2, exp3, exp7, exp8) answered within 6 s. The docs say the 6-second timer starts when the dialog appears, so these numbers also confirm that the dialog appears within a few milliseconds of the hook being sent. Notification has no tool details, so it is useful only as a "still waiting after 6 s" signal joined to the PermissionRequest by `session_id` + `prompt_id`.

## Recommendation: hold window

**Recommended default: 90 s, the same with or without a focused viewer, hook `timeout` = hold + 5 s (95 s). Configurable.**

Why the focus rule is not needed: ARCHITECTURE section 8.1 drops the hold to a few seconds only "if the terminal prompt is suppressed while the hook waits". It is not suppressed (exp1, exp2, exp6, exp7), so holding never blocks the person at the terminal. The hold window only decides how long the city's Allow and Deny buttons can still act.

Tradeoff:

| | Shorter (for example 15 s) | 90 s (recommended) | Longer (for example 300 s) |
| --- | --- | --- | --- |
| Answering from the city | Often too late if you notice the red agent after a glance away | Covers a normal "notice, read, decide" | Covers stepping away |
| Stale open request after a terminal Yes | Short | Up to 90 s, or until the tool finishes | Up to 300 s |
| Cost while held | One open local socket | Same | Same |

The real cost of a long window is the stale case, not resources. After a terminal Yes the request stays open (exp2), so a viewer click during that time is written to an open socket and ignored (exp3). A longer window widens that gap, especially for long-running tools, where `PostToolUse` arrives only at the end. 90 s keeps the gap bounded while still giving the city a useful window. If the owner values answering from another room over that risk, 300 s works the same way.

Rules the engine needs whatever the window (proposed; changes to ARCHITECTURE.md are the lead's and owner's call):

1. **Hook socket closed before the engine answered** = answered No in the terminal (and, untested, Esc or the session ending). Close the PendingRequest as "answered elsewhere" immediately. Because the hook `timeout` is above the hold window, a close is never a timeout as long as the engine answers on time.
2. **Matching `PostToolUse`** (same `session_id`, `prompt_id`, `tool_name`, and `tool_input`) while the request is open = answered Yes in the terminal. Close the request only if exactly one PermissionRequest in that prompt, counting open, answered, and expired ones, has that `tool_name` and `tool_input`; two identical calls in one prompt share every correlation field, so once a prompt has a duplicate, a `PostToolUse` closes nothing and attributes nothing for either call and those requests wait for socket close, a later turn event, or hold expiry. Otherwise close it and answer the held hook with an empty 2xx. A `Notification` never closes it: the `permission_prompt` Notification for the same `prompt_id` arrives 6 s into the hold while the dialog is still open (exp1, exp6). A later `UserPromptSubmit` or `Stop` from the same session shows the turn moved on and may close it. Other events from the same session (for example `PreToolUse` of a parallel sibling call) were not tested and must not close it.
3. **A delivered decision is not a confirmed decision.** Exp3 shows that a write to a still-open hook response can be ignored. The `.roborev.toml` invariant "a command succeeds only if its decision reached a still-open hook response" is necessary but not sufficient. Hook data cannot establish who answered first: telemetry is async and may be delayed or spooled, so the engine's receipt time minus `duration_ms` is not the tool's start time, and `PostToolUse` carries no source-side start timestamp. So every viewer decision is recorded as "sent, unconfirmed". A matching `PostToolUse` shows the tool ran: that is consistent with a viewer Allow but does not prove the Allow was the answer that counted, and it contradicts a viewer Deny (history then records that the terminal answered Yes). No positive signal for a hook deny was found; whether `PermissionDenied` or `PostToolUseFailure` fires on one is an open follow-up. How the UI words "sent, not yet confirmed" needs a decision.

## Limits of this spike

- One Claude Code version (2.1.312), Bash only, main session only. Subagent and teammate prompts are spike S-2.
- Whether `PostToolUseFailure` or `PermissionDenied` fires on a hook **deny** was not tested (exp5 ran before those hooks were added). They did not fire on a terminal No.
- Terminal options 2 and 3 ("always allow", "switch to auto mode") and the "Tab to amend" path were not exercised.
- Two identical tool calls in one prompt, which would make `prompt_id` correlation ambiguous, were not tested.

## Redaction

Fixtures were produced by a redaction pass: home directories become `/Users/dev`, the scratch directory becomes `/tmp/spike-s1`, transcript and scratchpad paths become `-tmp-spike-s1-proj`, and the bearer token becomes `<redacted-token>`. Session and prompt IDs are random UUIDs and were kept so the correlation evidence stays checkable. The fixtures were grepped for the owner's username, email domain, and `/Users/` paths other than `/Users/dev` before commit. Biome reformatted the JSON and `.mjs` fixtures; values are unchanged. Em dashes in Claude Code's own UI text (the auto mode tip line) were replaced with hyphens to follow the project's writing rule; nothing else in the pane captures was edited.
