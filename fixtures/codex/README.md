# Codex fixtures

Recorded for spike S-5 ([findings](../../docs/spikes/S-5-codex.md)) on 2026-11-08 with Codex CLI 0.166.0, model `gpt-6-luna` (effort `low`), macOS. The project was a throwaway git repo at `/tmp/s5-run/proj`. Every setting was a per-invocation `-c` override; nothing under `~/.codex` was edited. The spike doc lists the exact overrides.

## Files

Hook files hold one JSON object per line: `t_ms` (milliseconds since the run's first hook), `payload` (the hook's stdin, unchanged apart from redaction), and for `PermissionRequest` the recorder's own answer (`recorder_answer`, and `recorder_held_s` in the hold run). Each event was registered twice, sync and async. The files keep only the sync copies, because the async copies were identical in count and content.

| File | Run | What it shows |
| --- | --- | --- |
| `exec-hooks.jsonl` | `codex exec`, one prompt | Session lifecycle; Bash and `apply_patch` Pre/Post pairs; `PreModelRequest` and `PostModelRequest` with `token_usage`; `permission_mode: bypassPermissions` because exec forces `approval_policy = never` |
| `exec-events.jsonl` | the same run | `codex exec --json` stdout. Note that it omits the `git commit` call that hooks recorded |
| `tui-hooks.jsonl` | TUI in tmux, three prompts | `PermissionRequest` answered `allow` by the hook; a second one left to the terminal and denied with Esc (`PreToolUse` with no Post, then `Interrupt`); `SubagentStart`, subagent tool calls with `agent_id`, `SubagentStop` |
| `tui-hold-hooks.jsonl` | TUI, one prompt | A `PermissionRequest` held for 8 s with no answer, then approved at the terminal (`PostToolUse` 28 s later) |
| `notify.jsonl` | exec and TUI | `agent-turn-complete` payloads, including a hidden title-generation thread and the subagent thread |
| `otel-logs.jsonl` | all three | Flattened OTLP/HTTP JSON log records for `conversation_starts`, `user_prompt`, `tool_decision`, `tool_result`, `sandbox_outcome`, `agent_response`, `agent_communication` and `sse_event` (`response.completed` only). The first line holds the resource attributes. Startup, websocket and API noise is dropped |
| `otel-metrics.jsonl` | exec and TUI | Data points for `codex.turn.token_usage`, `codex.tool.call`, `codex.hooks.run`, `codex.multi_agent.spawn`, `codex.thread.started` and `codex.conversation.turn.count` |

**Status:** the JSONL files above were generated and redacted but not committed with this README, because the spike worker could not create new files. They are staged outside the repo (see the M8.05 task report) and should be added under these names. The excerpts below are copied from them.

## Excerpts

A Bash call whose escalation the hook answered (`tui-hooks.jsonl`):

```json
{"t_ms": 3297, "payload": {"session_id": "01a1bd20-2aeb-78d2-8cd2-11d3026574a7", "turn_id": "01a1bd20-6ac8-70e3-8c1d-0e04db1eed8b", "transcript_path": "~/.codex/sessions/2026/11/08/rollout-2026-11-08T16-46-04-01a1bd20-2aeb-78d2-8cd2-11d3026574a7.jsonl", "cwd": "/tmp/s5-run/proj", "hook_event_name": "PreToolUse", "model": "gpt-6-luna", "permission_mode": "default", "tool_name": "Bash", "tool_input": {"command": "curl -s -X POST http://127.0.0.1:47805/ping"}, "tool_use_id": "exec-169f00ab-d924-4dba-a626-4b9368813cf6"}}
{"t_ms": 3371, "payload": {"session_id": "01a1bd20-2aeb-78d2-8cd2-11d3026574a7", "turn_id": "01a1bd20-6ac8-70e3-8c1d-0e04db1eed8b", "transcript_path": "~/.codex/sessions/2026/11/08/rollout-2026-11-08T16-46-04-01a1bd20-2aeb-78d2-8cd2-11d3026574a7.jsonl", "cwd": "/tmp/s5-run/proj", "hook_event_name": "PermissionRequest", "model": "gpt-6-luna", "permission_mode": "default", "tool_name": "Bash", "tool_input": {"command": "curl -s -X POST http://127.0.0.1:47805/ping", "description": "May I run the requested POST request to the local service on port 47805 outside the network sandbox?"}}, "recorder_answer": {"hookSpecificOutput": {"hookEventName": "PermissionRequest", "decision": {"behavior": "allow"}}}}
{"t_ms": 3500, "payload": {"session_id": "01a1bd20-2aeb-78d2-8cd2-11d3026574a7", "turn_id": "01a1bd20-6ac8-70e3-8c1d-0e04db1eed8b", "transcript_path": "~/.codex/sessions/2026/11/08/rollout-2026-11-08T16-46-04-01a1bd20-2aeb-78d2-8cd2-11d3026574a7.jsonl", "cwd": "/tmp/s5-run/proj", "hook_event_name": "PostToolUse", "model": "gpt-6-luna", "permission_mode": "default", "tool_name": "Bash", "tool_input": {"command": "curl -s -X POST http://127.0.0.1:47805/ping"}, "tool_response": "{}", "tool_use_id": "exec-169f00ab-d924-4dba-a626-4b9368813cf6"}}
```

A subagent starting (`tui-hooks.jsonl`); `session_id` is the parent's:

```json
{"t_ms": 112626, "payload": {"session_id": "01a1bd20-2aeb-78d2-8cd2-11d3026574a7", "turn_id": "01a1bd22-2022-7792-87fc-64eee25ed0f2", "transcript_path": "~/.codex/sessions/2026/11/08/rollout-2026-11-08T16-48-12-01a1bd22-1ffe-77b0-a9f5-0de8a97c2ae1.jsonl", "cwd": "/tmp/s5-run/proj", "hook_event_name": "SubagentStart", "model": "gpt-6-luna", "permission_mode": "default", "agent_id": "01a1bd22-1ffe-77b0-a9f5-0de8a97c2ae1", "agent_type": "default"}}
```

An OTel tool decision (`otel-logs.jsonl`); `call_id` equals the hook `tool_use_id`:

```json
{"run": "t1", "timeUnixNano": "0", "attributes": {"event.name": "codex.tool_decision", "tool_name": "exec_command", "tool_namespace": "functions", "call_id": "exec-a96aeefa-41ba-470d-ac05-d264c9731be9", "decision": "approved", "source": "Config", "event.timestamp": "2026-11-08T21:42:48.048Z", "conversation.id": "01a1bd1d-18be-7452-8983-f2ae25db7784", "originator": "codex_exec", "model": "gpt-6-luna"}}
```

## Redaction

- The home directory is replaced by `~` and the OS username by `user`.
- OTel `user.email`, `user.account_id` and `auth_mode` are removed, and `host.name` is replaced by `<host>`.
- The encrypted `spawn_agent` task text (`gAAAAA...`) is truncated to `gAAAAA<encrypted, truncated>`.
- Session, turn, thread and call IDs are random UUIDs from a throwaway session and are kept.
- Prompts and outputs are the spike's own text about the throwaway repo.
- Codex sets `timeUnixNano` to `0` on log records; the real time is the `event.timestamp` attribute.
