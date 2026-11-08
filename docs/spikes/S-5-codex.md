# Spike S-5: Codex CLI adapter through hooks and OpenTelemetry

- **Ticket:** M8.05 (#105). **Recorded:** 2026-11-08 with Codex CLI 0.166.0 (Homebrew cask), model `gpt-6-luna` at reasoning effort `low`, ChatGPT login, macOS 27.
- **Fixtures:** [`fixtures/codex`](../../fixtures/codex) (seven redacted JSONL files; the README describes each).
- **Scope:** what Codex emits for a short session with tool calls through each surface it has (hooks, `notify`, OpenTelemetry), a draft mapping to protocol v1 events, gaps, and a go or no-go with the smallest viable adapter shape (ARCHITECTURE.md 8.4). Nothing here changes the architecture.

## Answer

**Go, hooks first.** Codex 0.166.0 has a hooks system that is close to Claude Code's: the same event names (`SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PermissionRequest`, `PostToolUse`, `Stop`, `SubagentStart`, `SubagentStop`, `SessionEnd`), a stable `tool_use_id` that pairs Pre and Post, `agent_id` on everything a subagent does, `"async": true` command handlers, and a `PermissionRequest` hook that can answer `allow` or `deny` with the same JSON shape as Claude Code. A Codex adapter is a second mapper plus an installer, not a new architecture. OpenTelemetry adds tokens and decision provenance, but it cannot be configured per project and is not needed for a first release. `notify` adds nothing that hooks do not already give.

The one material difference is **permission answering**: while a `PermissionRequest` hook is running, Codex shows "Running hook" and **no terminal prompt**. The prompt appears only after the hook returns without a decision. So the Claude Code rule from S-1 (hold for 90 s, focus-independent, decision #116) does not carry over. A held Codex request blocks the user's own terminal.

## How it was recorded

- A throwaway git repo at `/tmp/s5-run/proj` (two small files, one commit). A local recorder (`python3` HTTP server on `127.0.0.1:47805`) appended every OTLP/HTTP JSON post to JSONL. A hook script appended each hook's stdin to JSONL, and a `notify` script did the same with its argument.
- **Nothing under `~/.codex` was edited.** Everything was a per-invocation override:
  - Hooks as inline session-layer config: `-c 'hooks.<Event>=[{hooks=[{type="command",command="python3 -I .../hookrec.py sync",timeout=10},{type="command",command="... async",async=true,timeout=10}]}]'` for all 13 events, plus a sync-only `PermissionRequest`. Each event was registered twice, sync and async, to show whether background hooks get lost at exit.
  - `--dangerously-bypass-hook-trust`, because non-managed hooks need a hash-based trust review in `/hooks` before they run, and that review is persisted in `~/.codex/config.toml`.
  - `notify=["python3","-I",".../notify.py"]`, `analytics.enabled=false`, `otel.environment="spike"`, `otel.log_user_prompt=true`, `otel.log_agent_responses=true`, and `otel.exporter`, `otel.trace_exporter`, `otel.metrics_exporter` each set to `{otlp-http={endpoint="http://127.0.0.1:47805/v1/<logs|traces|metrics>",protocol="json"}}`.
  - Sandbox: `-s workspace-write` with `sandbox_workspace_write.exclude_slash_tmp=true`, `exclude_tmpdir_env_var=true` and `network_access=false`, so the agent could write only inside the project.
  - The owner's user hooks (`~/.codex/hooks.json`: roborev on `PreToolUse`, `PostToolUse`, `Stop`) were disabled with `-c 'hooks.state={"<home>/.codex/hooks.json:pre_tool_use:0:0"={enabled=false},...}'`. For the TUI runs, all 21 user plugins were disabled with an inline `plugins={...={enabled=false}}` table, so no plugin-bundled hooks could run under the trust bypass. Project trust for the TUI was `-c 'projects={"/tmp/s5-run/proj"={trust_level="trusted"}}'`.
  - Clean environment (`env -i` with `HOME`, `USER`, `PATH`, `LANG`, `TERM`).
- **Runs** (fixture names in brackets):
  1. **Dry runs** (not in fixtures): `codex exec --ignore-user-config ... "Say hi."`. They established the config mechanics below. They cost one tiny model call.
  2. **exec run** `[exec-*]`: `codex exec --ignore-user-config --json ...` with one prompt: `ls` and `cat`, edit `greet.py`, an escalated `curl` to the recorder, and `git commit`.
  3. **TUI run** `[tui-hooks]`: `codex --no-daemon --no-alt-screen -a on-request --disable fast_mode ...` in a private tmux server (`tmux -L s5`), driven with `send-keys`. Three prompts: two escalated `curl` calls (the hook allowed the first; the second fell through to the terminal prompt, which was denied with Esc), one prompt where the model ignored a "spawn a subagent" request, and one explicit `spawn_agent` request.
  4. **Hold run** `[tui-hold-hooks]`: the same TUI setup with a `PermissionRequest` hook that sleeps 8 s and returns nothing. The pane was captured every 2 s. The prompt was then approved at the terminal.
- Token use for all runs together was a few hundred thousand input tokens, more than 80 percent cached, and under 1,000 output tokens.

### Config mechanics learned the hard way

- **`--ignore-user-config` does not skip `~/.codex/hooks.json`.** In the first dry run, the owner's roborev `Stop` hook ran once (`codex.hooks.run` metric: `hook_name=Stop`, `source=user`, `status=completed`, 324 ms) in the throwaway repo. roborev's `agent-hook status` has no entry for that session, so it left no durable state. The disable above was in place for every run after that, and the `codex.hooks.run` metrics for the TUI runs show only `source=session_flags`.
- **The `-c` dotted-path parser splits quoted keys at dots.** `-c 'hooks.state."<home>/.codex/hooks.json:stop:0:0".enabled=false'` was reported as "unrecognized configuration setting" and ignored. Passing the parent as one inline TOML table works.
- **`-c projects."<path>".trust_level="trusted"` did not make a project `.codex/hooks.json` load in exec**, probably the same parsing issue. Inline session hooks avoid project trust entirely.
- **`codex exec` forces `approval_policy = never`.** `-c approval_policy="on-request"` was accepted but `codex.conversation_starts` reported `approval_policy: never`. Hooks then reported `permission_mode: "bypassPermissions"` even though the sandbox was `workspace-write`. `PermissionRequest` cannot fire in exec mode.
- **`otel` and `notify` are ignored in a project `.codex/config.toml`** (documented, with a startup warning). They are honored only from user config, profiles under `$CODEX_HOME`, managed config, or `-c`.
- The TUI has no `--ignore-user-config` and loads user plugins and their bundled hooks. One of the owner's plugin hook files failed to parse (`unknown field modules`), which is shown as a startup warning.

## What each surface emits

### Hooks (primary)

Every payload has `session_id`, `transcript_path` (the rollout file under `~/.codex/sessions/...`), `cwd`, `hook_event_name` and `model`. Turn-scoped events add `turn_id`. Most add `permission_mode`. No Codex-specific environment variables were passed to hook processes (the recorder captured `CODEX*`, `CLAUDE*` and `PLUGIN*` names: none).

| Event | Observed fields beyond the common ones | Notes |
| --- | --- | --- |
| `SessionStart` | `source` (`startup`), `permission_mode` | In the TUI it fires on the **first prompt**, not at launch. Quitting a TUI before any prompt gave a `SessionEnd` with no `SessionStart`. |
| `UserPromptSubmit` | `turn_id`, `prompt` (full text) | |
| `PreModelRequest` / `PostModelRequest` | `turn_id`; Post adds `status`, `error`, `token_usage` (`input_tokens`, `cached_input_tokens`, `cache_write_input_tokens`, `output_tokens`, `reasoning_output_tokens`, `total_tokens`); `agent_id` and `agent_type` inside a subagent | One pair per model request attempt. This is the only hook surface for tokens. No cost. |
| `PreToolUse` | `tool_name`, `tool_use_id`, `tool_input` | Bash: `{"command": "ls && cat greet.py"}`. Edits: `tool_name: "apply_patch"`, `tool_input.command` is the whole patch (`*** Begin Patch` / `*** Update File: /abs/path` / ...). Subagent tools: `collaborationspawn_agent`, `collaborationwait_agent` (namespace glued onto the name). |
| `PermissionRequest` | `tool_name`, `tool_input.command`, `tool_input.description` (the model's reason, e.g. "May I run the requested POST request to the local service on port 47805 outside the network sandbox?") | **No `tool_use_id`.** Arrives 70 to 80 ms after the matching `PreToolUse` in the same turn. |
| `PostToolUse` | `tool_name`, `tool_use_id`, `tool_input`, `tool_response` | Bash `tool_response` is the **bare output string, no exit code**: a `curl` that exited 7 gave `""`, the same as an empty success. `apply_patch` gives `"Exit code: 0\nWall time: 0 seconds\nOutput:\nSuccess. Updated the following files:\nM /tmp/s5-run/proj/greet.py\n"`. `spawn_agent` gives `{"task_name":"/root/readme_last_line"}`. |
| `Stop` | `turn_id`, `stop_hook_active`, `last_assistant_message` | Not sent for an interrupted turn. |
| `Interrupt` | `turn_id`, `permission_mode` | Sent when the user pressed Esc on the approval prompt. |
| `SubagentStart` | `turn_id`, `agent_id` (the child thread UUID), `agent_type` (`default`) | `session_id` is the parent's. Fired when the parent called `wait_agent`, 1.3 s after `spawn_agent` returned. |
| `SubagentStop` | `agent_id`, `agent_type`, `stop_hook_active`, `last_assistant_message`, `agent_transcript_path` | |
| `SessionEnd` | `reason` (`other`, the only documented value) | Always synchronous; default timeout 1 s, max 3 s. Fired at `codex exec` exit and at TUI `/quit`. |

- **Code mode:** the model wraps tool calls in a JavaScript `exec` tool. Hooks fire only for the nested calls (`Bash`, `apply_patch`), never for the outer `exec`, which is what Taskville wants.
- **Async hooks lost nothing in the recorder files.** In every run the async handler count in the hook files matched the sync count per event, including the final `Stop` in `codex exec`. The `codex.hooks.run` metrics are less complete (for example, no async `SubagentStop`), so the lifecycle-end hooks are still recommended as synchronous (gap 11).
- Hook latency was 70 to 150 ms per sync handler (a `python3` start each time), so telemetry hooks must be async, as for Claude Code.

### `notify`

One JSON argument per completed turn, `type: "agent-turn-complete"`, with `thread-id`, `turn-id`, `cwd`, `client` (`codex_exec` or `codex-tui`), `input-messages` and `last-assistant-message`.

- `input-messages` is **every user message in the thread so far**, not just this turn's.
- It also fired for a hidden title-generation thread (`input-messages` was Codex's own "Generate a concise, single-line task title ..." prompt) and for the subagent's thread (no `client`, empty `input-messages`).
- It only fires at turn end, it is user-level config only, and it overlaps fully with `Stop`. Not useful for the adapter.

### OpenTelemetry

Resource attributes: `service.name` (`codex_exec`, `codex-tui`), `service.version`, `env` (the `otel.environment` tag) and **`host.name`**. Every log record also carries **`user.email` and `user.account_id`**, plus `conversation.id` (the session or thread UUID), `model` and `originator`.

- **Logs** (`/v1/logs`), the useful ones:
  - `codex.conversation_starts`: `approval_policy`, `sandbox_policy`, `reasoning_effort`, `mcp_servers`, `provider_name`. One per thread, including the title thread and each subagent thread.
  - `codex.user_prompt`: `prompt_length`, plus `prompt` only with `log_user_prompt`.
  - `codex.tool_decision`: `tool_name` (`exec_command`, `apply_patch`), `call_id` (**equal to the hook `tool_use_id`**), `decision`, `source`. A hook `allow` was logged as `source: Config`, the same as a call that needed no approval. A terminal approval was logged as `source: User`. **The call denied with Esc had no `tool_decision` and no `tool_result` at all.**
  - `codex.tool_result`: `call_id`, `duration_ms`, `success`, `arguments`, `output` (capped at `otel.tool_result.max_bytes`, default 2048), `agent_name` (`/root`). `success` was `"true"` for exit codes 7 and 128; the exit code is only inside `output` ("Process exited with code 7"). The outer code-mode `exec` call is logged too, under its own `call_...` id.
  - `codex.sandbox_outcome`: `call_id`, `outcome: denied` for the `git commit` the sandbox blocked.
  - `codex.agent_response`: `agent.type` (`main` or `subagent`), `turn.id`, `response` (with `log_agent_responses`).
  - `codex.agent_communication`: `kind` (`spawn`, `result`), `sender_thread_id`, `receiver_thread_id`, `content` (encrypted for `spawn`, `[plaintext]` placeholder for `result`). This is the **only place that links parent thread to subagent thread** besides hook ordering.
  - `codex.sse_event` with `event.kind: response.completed`: per-response token counts.
  - Noise: `codex.startup_phase`, `codex.websocket_*`, `codex.api_request`, `codex.turn_ttft`.
- **Traces** (`/v1/traces`): internal implementation spans (`fs.read_file` 258 and `fs.get_metadata` 332 in a one-word session, plus `append_items`, `auth`, `build_tool_router` and so on). Nothing at the level of tool calls or turns. Not useful.
- **Metrics** (`/v1/metrics`): over 60 instruments. Useful ones: `codex.turn.token_usage` (histogram by `token_type`: `input`, `cached_input`, `cache_write_input`, `output`, `reasoning_output`, `total`), `codex.tool.call`, `codex.multi_agent.spawn` (`role`), `codex.hooks.run` (`hook_name`, `source`, `execution_mode`, `status`). Metric data points carry no `conversation.id`, so they cannot be attributed to a session or agent.

### Other surfaces seen in passing

- `codex exec --json` prints a turn event stream (`thread.started`, `item.started` and `item.completed` for `command_execution` with `exit_code`, `file_change` with `changes[].path` and `kind`, `agent_message`, `turn.completed` with `usage`). It is exec-only, and it **omitted the `git commit` call** that hooks and OTel both recorded.
- Rollout transcripts under `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl` (`transcript_path`). The docs say the format is not a stable interface. They are a later candidate for an import adapter (like M8's Claude transcripts), not for live telemetry.
- `codex queue --thread <session> --message <text> [--resume]` queues a message into an existing session. This is a candidate for **replies** (ARCHITECTURE.md 9.4). It was not run.

## Draft mapping

`sourceId: "codex"`. Envelope `sessionId` = `session_id`. The main agent is the session's agent, as for Claude Code. A subagent's events carry `agent_id`, which maps to the child agent's `sourceAgentId`. `toolCallId` = `tool_use_id`.

| Taskville event | Codex source | Mapping notes |
| --- | --- | --- |
| `session.started` | `SessionStart` | `workingDirectory` = `cwd`. `source` (`startup`, `resume`, `clear`, `compact`, `fork`) could go to a later field; `compact` should not start a new session. |
| `session.ended` | `SessionEnd` | `outcome` = `reason` (always `other`). Must tolerate an end with no start (TUI quit before first prompt): ignore it if the session is unknown. |
| `session.prompt_submitted` | `UserPromptSubmit` | Prompt text stays evidence, as for Claude Code. |
| `session.turn_ended` + `activity.ended` | `Stop` | Same as Claude Code. |
| `session.turn_failed` | `PostModelRequest` with `status: failed` (not observed), or `Interrupt` | No `StopFailure` equivalent. `Interrupt` should end the turn with a reason such as `interrupted` and close any open tool calls of that turn. |
| `session.idle_prompt` | none | No idle notification exists (Claude Code's `Notification` `idle_prompt`). The city would rely on `turn_ended` for "waiting". |
| `tool_call.started` | `PreToolUse` | `toolName` = `tool_name` with the `collaboration` prefix stripped (`spawn_agent`, `wait_agent`). `filePaths` for `apply_patch` come from the patch headers (`*** Add File:`, `*** Update File:`, `*** Delete File:`, `*** Move to:`), which are absolute. Bash: `summary` = first line of `tool_input.command`. |
| `tool_call.finished` | `PostToolUse` | **The outcome is unknown, not `succeeded`.** A Post only says the tool returned. Bash `tool_response` is the bare output string with no exit code: the fixture `curl` that exited 7 has `tool_response: ""`, the same as an empty success. Where exit evidence could come from, and whether it does: (a) the hook `tool_response`: no field for Bash; `apply_patch` has `Exit code: N` only as text at the start of the string; (b) OTel `codex.tool_result`: `success` is `"true"` even for exit codes 7 and 128, so it is not evidence; the exit code is only inside the `output` text ("Process exited with code 7"), which is truncated at `otel.tool_result.max_bytes`, needs user-level OTel config, and is a display format, not a contract; (c) OTel `codex.sandbox_outcome: denied` is reliable for sandbox denials only; (d) `codex exec --json` `exit_code` is a real field, but exec-only and it dropped one call. None of these is a reliable, always-present field. Protocol v1 `phase` allows only `succeeded` or `failed`, so the adapter ticket needs an outcome-unknown representation (an `unknown` phase or an optional phase, which is a protocol change needing a decision) and must not emit `succeeded` without evidence. No `durationMs` in hooks (Pre/Post receive times are an approximation; OTel has `duration_ms`). A denied call gets **no Post**: close it on that turn's `Interrupt` or next `Stop`, and record that it was ended without a result rather than claiming a failure cause. |
| `activity.started` | `PreToolUse` | `apply_patch` -> implementing; `spawn_agent` -> dispatching; Bash -> the same command heuristics as Claude Code (test runners -> testing, flagged `heuristic`); MCP tools (`mcp__server__tool`) -> researching by default. |
| `request.opened` (kind `permission`) | `PermissionRequest` | No `tool_use_id`, so the request ID must be derived like Claude Code's (from the hook's `sourceEventId`), and pairing with the tool call is by order within `(session_id, agent_id, turn_id)`. `inputPreview` = `tool_input.command`; `reason` = `tool_input.description`. |
| `request.resolved` (engine) | the bridge's own answer, or later evidence | Answered here: the bridge returned allow or deny. Answered elsewhere: resolve only on **one unambiguous match**. A `PostToolUse` resolves the request as approved only if it is the single open tool call matching the request on `session_id`, `turn_id`, `agent_id` (or both absent), `tool_name` and `tool_input.command`. If more than one open call matches (parallel identical calls), or none does, the request stays open, falls to the normal hold expiry, and the ambiguity is logged. A Post from a different tool, or a different input in the same turn, never resolves it. `Interrupt` for that `turn_id` ends the turn, but it only says the turn was interrupted, so record the request as answered elsewhere without a decision (Esc and a plain interrupt look the same). The recordings had only sequential calls, so the parallel case is unverified. OTel `tool_decision source=User` carries `call_id` and would make an approval exact, but it requires the optional receiver. |
| `agent.registered` (subagent) + `agent.connected` | `SubagentStart` | `sourceAgentId` = `agent_id`, `parentAgentId` = the session's main agent, `role` = `agent_type`. `displayName` = the `agent_id` (or a short form of it). The `spawn_agent` `tool_response.task_name` (`/root/readme_last_line`) is the only readable name, but nothing in the hooks links it to an `agent_id`: `SubagentStart` has no task name, and pairing by "latest spawn" would mislabel parallel subagents. Do not name from order. A name can be attached later only from an exact link, if one is found (OTel `codex.agent_communication` gives `receiver_thread_id` but its content is encrypted, so it links threads, not names). If a future ticket chooses an order-based name anyway, it must be marked heuristic. |
| `agent.finished` | `SubagentStop` | `last_assistant_message` is the subagent's final answer. |
| `team.*`, `task.*` | none | Codex has no agent teams or shared task list. `wait_agent` is visible as a tool call only. |
| tokens and cost | `PostModelRequest.token_usage` (per attempt, per `agent_id`) | Protocol v1 has no token event; this lines up with the planned OTLP receiver work (M5.12). Codex reports **no cost** anywhere (ChatGPT plan auth); cost would have to be computed from a price table. |

## Gaps

1. **Permission hold semantics differ from Claude Code.** The terminal prompt is hidden while the hook runs (hold run: "Working (12s) · Running hook", prompt appeared only after the 8 s hook returned). A long hold freezes the user's terminal; if Taskville is slow or down, the user waits up to the hook timeout. The Codex bridge needs a short hold (a few seconds) unless a viewer is focused, which is the S-1 fallback that Claude Code did not need.
2. **Headless runs cannot be answered.** `codex exec` forces `approval_policy = never`, so `PermissionRequest` never fires and escalations just fail. Only the TUI (and app-server clients, not tested) produce permission requests.
3. **No exit code for Bash in hooks**, so the outcome of a finished call is unknown. Protocol v1 cannot say "unknown" (`phase` is `succeeded` or `failed`), so the adapter needs a protocol decision; reporting `succeeded` would be a claim without evidence. OTel output text is a weak enrichment, not a fix (see the mapping table).
4. **Denied calls leave no `PostToolUse`**, and OTel logs nothing for them either. The adapter has to close open calls on `Interrupt` or `Stop`.
5. **`PermissionRequest` has no `tool_use_id`**, the same limitation as Claude Code. A terminal answer can be inferred only from a single unambiguous content match (session, turn, agent, tool name, input). Otherwise the request stays open until it expires.
6. **No exact subagent name.** `SubagentStart` has no task name; the `spawn_agent` task text is encrypted in both hooks and OTel. OTel `codex.agent_communication` links parent and child thread IDs exactly, but not the name, so subagents are shown by `agent_id`.
7. **No idle-prompt event** and no `StopFailure` equivalent.
8. **Tokens only per model attempt; no cost.** OTel metrics have no session attribution; OTel logs (`sse_event response.completed`) do, by `conversation.id`.
9. **Installation friction.** User and project hooks need a trust review in `/hooks` before they run, and project hooks need a trusted project. `taskville install codex` cannot make them run without the user opening `/hooks` (or editing trust hashes in `~/.codex/config.toml`, which Taskville must not do silently). OTel can only be enabled in user-level config.
10. **Privacy of OTel.** Every log record carries `user.email`, `user.account_id` and the resource carries `host.name`. A receiver must strip them at ingest (ARCHITECTURE.md 13).
11. **Lifecycle-end hooks need synchronous handlers.** `SessionEnd` always runs synchronously (documented; default timeout 1 s, max 3 s), and Codex cancels unfinished background hooks when a session ends. In the recorded `codex.hooks.run` metrics, `SessionEnd` and `SubagentStop` appear only as synchronous executions. The hook file did record one async `SubagentStop`, so async may work, but the metrics do not confirm it. Configure both synchronously: post once with a short timeout, and spool on failure within the hook timeout. Never retry in the hook.
12. Not tested: `resume`, `clear`, `compact` and `fork` session sources, MCP tool calls, `PreCompact` and `PostCompact`, the app-server and desktop app (which share hooks per the docs), Windows, a hook `deny` answer, and what the user sees when a `PermissionRequest` hook times out.

## Recommendation: smallest viable adapter

**Go**, as a post-release adapter with this shape:

- **Telemetry: yes, through async command hooks.** `taskville install codex --scope user|project` writes Taskville's entries into `~/.codex/hooks.json` or `<repo>/.codex/hooks.json` (one representation per layer, never inline TOML in the user's `config.toml`), shows the diff and asks, then tells the user to open `/hooks` and trust them. The hooks are the same curl shim as Claude Code, posting to `POST /v1/sources/codex/hooks`. Use `"async": true` for `SessionStart`, `UserPromptSubmit`, `PreToolUse`, `PostToolUse`, `Stop`, `Interrupt`, `SubagentStart` and `PostModelRequest` (tokens, kept as evidence until a token event exists). Configure **`SessionEnd` and `SubagentStop` synchronously** (gap 11): one post with a sub-second timeout, then spool to the local file, all within the hook `timeout` (at most 3 s for `SessionEnd`). A new pure mapper `packages/adapters/src/codex` follows the mapping above and reuses the Claude Code helpers (ids, text cleaning, activity rules).
- **Permission answers: yes, behind a short hold.** A synchronous `PermissionRequest` command hook (Codex hooks have no `http` handler type, so the shim forwards stdin to `POST /v1/bridge/codex/permission` and prints the engine's JSON) with a hold window of a few seconds unless a viewer is focused, and a hook `timeout` just above it. TUI only; declare it unavailable for `codex exec` sessions (`permission_mode: bypassPermissions`).
- **Replies: not in the first cut.** `codex queue --thread <session_id> --message` is the candidate and needs its own spike.
- **OpenTelemetry: optional, later.** If the planned OTLP receiver (M5.12) lands, Codex logs add exit codes (inside `tool_result.output`), decision provenance (`source: User` vs `Config`), parent and child thread links, and per-response tokens, all joinable to hooks by `call_id` and `conversation.id`. It needs user-level config and must strip `user.email`, `user.account_id` and `host.name`.
- **Do not use `notify`.**

## Risks

- **Hook trust review** is a hard step for users; if they skip `/hooks`, nothing is recorded and Codex only prints a startup warning. The installer and `taskville status` should detect "installed but no events yet".
- **Blocking the user's terminal** if the permission hold is too long or the engine hangs. The hook timeout is the only backstop.
- **Schema churn.** Codex is moving fast (0.167.0 was offered during the spike). Hook fields are documented as release behavior with generated schemas upstream; tool names already differ from the docs (`collaborationspawn_agent`, not `spawn_agent`). Fixtures should be re-recorded per supported release.
- **Code mode and other tool paths can opt out of hooks.** The docs say to treat tool hooks as "a useful guardrail, not a complete enforcement boundary"; hosted tools such as web search never fire hooks.
- **User hooks and plugins run alongside Taskville's.** Multiple matching hooks run concurrently, and any `deny` wins, so another `PermissionRequest` hook can override a Taskville allow.
- **The trust-bypass flag** used here must never be part of an install recipe.
