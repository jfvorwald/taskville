# Spike S-2: subagent and agent-team hook attribution

- **Ticket:** M1.04 (#4). **Recorded:** 2026-10-30 with Claude Code 2.1.312, model `claude-haiku-5-5`, macOS.
- **Fixtures:** [`fixtures/claude-code/subagent`](../../fixtures/claude-code/subagent), [`team`](../../fixtures/claude-code/team), [`toolcalls`](../../fixtures/claude-code/toolcalls). Each directory has a README.
- **Scope:** the questions in ARCHITECTURE.md section 8.1 (Spike S-2), plus what M2.03, M2.04 and M5 need. Nothing here changes the architecture; the attribution choice is the owner's at G1 (see the end).

## How it was recorded

- A throwaway git repo (three small files) in a scratch directory, never a real project.
- Every hook in section 8.1, plus `MessageDisplay`, was registered twice: in the throwaway project's `.claude/settings.json` and in a file passed with `--settings`. Each registration is an async command hook (`"async": true`) running a curl shim that posts stdin to a local recorder on `127.0.0.1:47802`, which stamps the receive time. `PermissionRequest` also had a synchronous `http` hook to the same recorder, which answered with an empty 200 so the normal prompt still showed.
- Every session ran with a clean environment (`env -i`, so nothing leaked from the session running the spike) and `--setting-sources project,local`, so the owner's user hooks and plugins did not fire into the fixtures. The one exception is the user-settings check below.
- Subagent scenarios ran headless (`claude -p`). Agent teams do not spawn in `-p` mode (documented, and confirmed: the docs say a named subagent runs as an ordinary subagent there), so team scenarios ran interactively in a private tmux server (`tmux -L spike-s2`), driven with `send-keys` and `capture-pane`.
- Teams were recorded in both display modes, because the answers differ: **in-process** (`--teammate-mode in-process`, the default) and **split-pane** (`--teammate-mode tmux`).
- Fixtures keep one registration (the `--settings` one). Both registrations produced the same multiset of events in every run; see "Ordering".

## Answers

### 1. Do teammates run hooks from user settings?

**Yes, in both modes, with one caveat on how it was shown.**

- **In-process teammates** run inside the lead's process (same PID for every hook, same `CLAUDE_CODE_SESSION_ID` in the hook environment), so they run exactly the hooks the lead loaded. Project and `--settings` hooks fired for every teammate tool call, with the teammate's `agent_id`.
- **Split-pane teammates** are separate `claude` processes. The lead launches them with this argv (captured with `ps`, paths shortened):

  ```
  claude --agent-id pip@session-a7286c33 --agent-name pip --team-name session-a7286c33 --agent-color blue
         --parent-session-id a7286c33-... --settings /tmp/spike-s2/cfg/cli-settings.json
         --setting-sources=project,local --model claude-haiku-5-5
  ```

  The lead forwards `--settings` and `--setting-sources`. Project and `--settings` hooks fired in both teammate sessions.
- **User settings, direct check:** a lead started with default setting sources spawned one split-pane teammate (argv then had no `--setting-sources`). Running `/hooks` inside the teammate's pane listed `[User]` entries from the owner's real `~/.claude/settings.json` (its PreToolUse, PostToolUse, Stop and SubagentStop hooks) next to `[Project]` and `[Plugin]` entries. This was read-only: nothing under `~/.claude` was edited.
- **Caveat:** the plan was to prove it with a hook in a throwaway user settings file through `CLAUDE_CONFIG_DIR`. That directory does load its `settings.json` (its SessionStart and SessionEnd hooks fired), but the macOS Keychain entry is keyed to the config directory, so the session was "Not logged in" and could not spawn a team. Credentials were not copied. The `/hooks` listing shows the user hooks are *loaded* in a teammate; a payload from a user-scope hook fired by a teammate was not recorded. To see that directly, the owner can add a temporary async hook to user settings that appends stdin to a file, run a split-pane and an in-process team, and look for the teammate's `session_id` (split-pane) or `agent_id` (in-process) in that file.
- **Consequence for install:** `taskville install claude-code --scope user` reaches every teammate. `--scope project` also reaches them, as long as the lead runs in that project. A lead started with `--setting-sources` passes the same restriction to split-pane teammates, so a user-scope install is invisible to those teammates.

### 2. Does each teammate get its own `session_id`?

**It depends on the display mode.**

| | In-process | Split-pane |
| --- | --- | --- |
| `session_id` on teammate hooks | The **lead's** | Its **own** (a new UUID per teammate) |
| `agent_id` on teammate hooks | `a<name>-<16 hex>`, e.g. `apip-5cb5e9bb3f2f1097`, on every event, stable for the team's life | **Absent** on all teammate events |
| `agent_type` | The teammate name (`pip`) | Absent, or the `subagent_type` the lead passed (`general-purpose`), never the name |
| `teammate_name`, `team_name` | Only on `TeammateIdle` | Only on `TeammateIdle` |
| Lifecycle hooks | `SubagentStart` at the start of **every turn**, `SubagentStop` plus `TeammateIdle` at the end of every turn, all with the same `agent_id` | Its own `SessionStart` (`source: startup`), `Stop` plus `TeammateIdle` per turn, and `SessionEnd` |
| `MessageDisplay` | Not fired for teammate text | Fired, under the teammate's own `session_id` |

- `team_name` is `session-<first 8 chars of the lead's session_id>` in both modes, which links a teammate to its lead.
- The lead's `PostToolUse` for the spawning `Agent` call (input has `name`) returns `status: "teammate_spawned"`, `name`, `teammate_id` (`pip@session-a7286c33`), `agent_id`, `team_name`, `color`, `is_splitpane`, and `tmux_pane_id` (`"in-process"` or a pane like `%1`). In split-pane mode the returned `agent_id` (`pip@session-…`) never shows up in the teammate's own hooks, and the teammate's `session_id` is not in the response.
- **So in split-pane mode the only hook-based link from a teammate session to its name is its first `TeammateIdle`** (`session_id`, `teammate_name`, `team_name`). Until that first turn ends, its events come from an unknown session in the same `cwd`. The teammate's `SessionStart` comes right after the lead's spawn call, but with parallel spawns, matching them by order is a guess.

### 3. Which fields attribute a teammate's `PermissionRequest`?

**In-process: `agent_id` and `agent_type`. Split-pane: no `PermissionRequest` fires at all.**

- **In-process** (`team/in-process.jsonl`): the teammate's prompt shows in the lead's terminal as "Bash command · from the pip agent". The hook payload is:

  ```json
  {"session_id": "<lead>", "prompt_id": "…", "permission_mode": "default", "agent_id": "apip-5cb5e9bb3f2f1097",
   "agent_type": "pip", "effort": {"level": "medium"}, "hook_event_name": "PermissionRequest",
   "tool_name": "Bash", "tool_input": {"command": "touch perm-pip.txt && echo …", "description": "…"}}
  ```

  `agent_id` identifies the teammate, `agent_type` carries its name, and `session_id` is the lead's. There is no `tool_use_id`. Pairing it with the teammate's `PreToolUse` by `(session_id, agent_id, tool_name, tool_input)` is a content match, not an ID: it is ambiguous if one agent has two identical calls open at once. The http hook received a body identical to the command hook's stdin. Right after it comes a `Notification` with `notification_type: "permission_prompt"` and the lead's `session_id`, with **no** `agent_id`.
- **Split-pane** (`team/split-pane.jsonl`): the teammate's `PreToolUse` arrives under the teammate's session. Then the **lead's** session gets `Notification` `{"notification_type": "worker_permission_prompt", "message": "pip needs permission for Bash"}` and then `{"notification_type": "permission_prompt", "message": "Claude needs your permission"}`. The prompt is answered in the lead's terminal. **No `PermissionRequest` hook fired in either process**, so the permission bridge (section 8.1) cannot see or answer it. The teammate's name is only in the English `message` text. When the prompt is answered, the teammate's `PostToolUse` closes the call.
- Teammate permission mode: in both split-pane runs, the teammates reported `permission_mode: "auto"` while the lead was in manual (`"default"`). The lead's `--permission-mode manual` was not in the teammate argv (captured in the second run). The docs say teammates inherit the lead's mode; that was not what happened here. The `Bash(touch:*)` ask rule (from the forwarded `--settings`) still forced a prompt. Where `auto` came from was not determined.

### 4. Does `MessageDisplay` fire inside subagents?

**No.** Across all six recordings (two headless, four interactive), no `MessageDisplay` event carried an `agent_id`, and none held subagent or in-process teammate text. It fires only for the top-level session's own messages: the main session, the lead, or a split-pane teammate under its own `session_id`.

- Fields: `session_id`, `prompt_id`, `transcript_path`, `cwd`, `turn_id`, `message_id`, `index`, `final`, `delta`. There is no `permission_mode` or `effort`.
- In interactive mode a message arrives as several chunks (`index` 0..n, `final: true` on the last). In `-p` mode it arrives as one chunk.
- To show a subagent's narration, the feed needs `SubagentStop.last_assistant_message` (its final text only) or the subagent transcript. Hooks give nothing per message.

### 5. Actual `tool_response` shapes for Edit, Write and Bash

Taken from `toolcalls/pairs.jsonl`; key order as received.

- **Edit**: `{filePath, oldString, newString, originalFile, structuredPatch, userModified, replaceAll}`. One in-process teammate Edit also had `contentNotInModelContext: true`.
  - `structuredPatch` is a list of hunks `{oldStart, oldLines, newStart, newLines, lines: [" ctx", "-old", "+new"]}`. These line numbers come from Claude Code, so an Edit card can show them without inventing anything.
  - `originalFile` is the **whole file before the edit**. In a real repo that can be large and sensitive. The 64 KB evidence cap and secret masking (sections 7.4 and 13) must apply to it, and the privacy setting must hide it.
- **Write** (new file): `{type: "create", filePath, content, structuredPatch: [], originalFile: null, userModified}`. A Write over an existing file was not recorded, so the `type: "update"` shape is unverified.
- **Bash** (success): `{stdout, stderr, interrupted, isImage, noOutputExpected}`. There is **no exit code and no duration** in the response. `PostToolUse` has a top-level `duration_ms`.
- **Bash** (failure) is a **`PostToolUseFailure`** with no `tool_response`: `{error: "Exit code 1\ncat: missing.txt: No such file or directory", is_interrupt: false, duration_ms: 26, tool_input, tool_use_id, …}`. The exit code exists only inside the `error` string.
- **Agent** (a subagent launched in the background, now the default for the main session): `{isAsync: true, status: "async_launched", agentId, description, prompt, resolvedModel, outputFile, canReadOutputFile, canContinueAgent}`.
- **Agent** (synchronous, here a nested subagent): `{status: "completed", agentId, agentType, content: [text blocks], toolsUsed, totalDurationMs, totalTokens, totalToolUseCount, usage, toolStats: {readCount, searchCount, bashCount, editFileCount, linesAdded, linesRemoved, otherToolCount}, …}`.
- **Agent** (teammate spawn): see answer 2.
- **SendMessage**: `{success, message, msg_id, routing: {sender, senderColor, target: "@bo", targetColor, summary, content}}`. `routing.content` is **truncated** with "…" for longer messages, so take the body from `tool_input.message`. Shutdown traffic is also SendMessage: `{success, message, request_id, target}`, with `tool_input.message` set to an object like `{type: "shutdown_request", reason}` or `{type: "shutdown_response", request_id, approve}`.

### 6. Is `tool_use_id` stable between Pre and Post?

**Yes.** Across the five fixture streams (61 PreToolUse events), every PostToolUse or PostToolUseFailure had a PreToolUse with the same `tool_use_id`, and the `session_id`, `agent_id` and `tool_name` matched. A Post never arrived before its Pre. There were two exceptions to keep in mind:

- `tool_input` can differ between Pre and Post for **SendMessage**: in some runs Pre carries a normalized superset (`type`, `recipient`, `recipient_kind`, `content`) that Post does not have. Store Pre's input and do not compare.
- A PreToolUse can have **no Post at all**. In `team/split-pane-speculative.jsonl`, an internal helper agent (see below) fired `PreToolUse` Bash (`echo "waiting for teammates"`) with an `agent_id`, no `agent_type`, and no Post or failure afterwards.

## What M2.03, M2.04 and M5 also need

**Subagent identity and parents (M2.04)**

- Subagent hooks carry `agent_id` (17 hex chars with an `a` prefix, e.g. `afdf84bea07a9064c`) and `agent_type`, as documented. The `session_id` and `transcript_path` are the **parent session's**, even inside a nested subagent.
- `SubagentStart` has **no parent field**. The only recorded link is the parent's `PostToolUse(Agent)`: its `tool_response.agentId` names the child, and its `tool_use_id` matches the parent's `PreToolUse(Agent)`, which identifies the caller (the main session if that event has no `agent_id`, otherwise the subagent with that `agent_id`; in the nested case outer's `PreToolUse` Agent has `agent_id` = outer). For a background launch this Post arrives right after `SubagentStart`. For a synchronous call it arrives only after the child's `SubagentStop`, so for the child's whole life the parent is unknown. Until that Post arrives, leave the parent unknown. If the city wants a provisional link, taking the most recent unmatched `PreToolUse(Agent)` whose `subagent_type` matches the child's `agent_type` is a **heuristic** and must be labelled as one. In these recordings it always picked the right parent, but async hooks race (see Ordering), so overlapping launches can pick the wrong one.
- Background subagents: the main session's `Stop` fires while they are still running (`Stop.background_tasks` lists them). When each one finishes, the parent gets a new `UserPromptSubmit` (a task notification) and another turn. So "parent waiting on subagents" is not "parent stopped".
- `SubagentStop` has `agent_transcript_path` (`…/projects/<slug>/<session>/subagents/agent-<agent_id>.jsonl`), `last_assistant_message`, `background_tasks` and `session_crons`.
- **Internal helper agents:** interactive sessions fire `SubagentStop` with `agent_type: ""` for agents that never had a `SubagentStart`. Their `last_assistant_message` is a suggested next prompt (for example "check on the teammates"), so they look like prompt-suggestion helpers. One also fired a `PreToolUse` with no Post (above). **Ignore any `agent_id` that never had a `SubagentStart`**, and do not leave its tool call "running" in the feed.
- In-process teammates use `SubagentStart` and `SubagentStop` per turn, so `SubagentStop` on a teammate means **idle, not gone**. Only subagents whose `agent_type` is not a teammate name should fade out on `SubagentStop`. The spawn response (`status: "teammate_spawned"`) tells the two apart.

**Teams (M2.04)**

- A lead is the session whose `Agent` call has `tool_input.name` and returns `status: "teammate_spawned"`.
- Messages: `SendMessage` `PreToolUse` has `tool_input.to` (a teammate name or `team-lead`), `summary` and `message`. The sender is the calling agent: its `agent_id`/`agent_type` in-process, its own session in split-pane mode.
- **`TaskCreated` and `TaskCompleted` were not captured: NOT RUN.** In 2.1.312 the `TaskCreate` and `TaskUpdate` tools were not available to the spike sessions, even with `CLAUDE_CODE_ENABLE_TASKS=1`. The lead looked for them with ToolSearch and found only `TaskStop`. The task-list mapping in section 2.9 still has no recorded payload. Neither `Elicitation` nor `StopFailure` fired; they need an MCP server and an API error, which were out of scope.
- Shutdown shows as SendMessage `shutdown_request`/`shutdown_response` traffic, then (split-pane) the teammate's `SessionEnd` with `reason: "other"`.

**Sessions and ordering (M2.03)**

- Common fields seen: `session_id`, `prompt_id` (one per user turn; background subagent events keep the prompt_id of the turn that launched them), `transcript_path`, `cwd`, `scratchpad_dir`, `permission_mode` (not on SessionStart, SessionEnd, SubagentStart, Notification or MessageDisplay), and `effort` (an object `{level}`). `SessionStart` usually also has `model`, plus `agent_type` when the session started with an agent.
- `SessionEnd.reason`: `prompt_input_exit` after `/exit`, `other` when the process was torn down (teammate shutdown, tmux killed, and the end of `-p` runs).
- **Ordering:** two identical async registrations of the same hooks received the same events in a **different order** in all four interactive team runs (6 to 15 positions differed per run), and in the same order in the two headless runs. Async hooks are separate processes that race. Ingest order is what Taskville knew and when, but a mapper must not assume, for example, that `SubagentStart` arrives before the child's first `PreToolUse` when they are close together. Within one registration, no Post-before-Pre was seen.
- Hook processes get `CLAUDE_CODE_SESSION_ID`, `CLAUDE_PROJECT_DIR`, `CLAUDE_PID`, and (split-pane teammates) `CLAUDE_CODE_CHILD_SESSION=1`. None of these names the teammate.
- `transcript_path` is under `~/.claude/projects/<slug>/<session_id>.jsonl`. Section 2.9 says Taskville reads only hook inputs, so these paths are recorded but not read.

## Recommendation for G1: teammate attribution

**Recommended (default):** attribute by display mode, using only hook fields, and be honest where the hooks fall short.

1. **In-process teammates (the default mode):** the agent is `(lead session_id, agent_id)`, and its name is `agent_type`, confirmed by the lead's `teammate_spawned` response. A `PermissionRequest` with that `agent_id` turns the teammate red, and the bridge can answer it, because the request is held in the lead's process like any other.
2. **Split-pane teammates:** the agent is its own `session_id`. It joins the team on its first `TeammateIdle`, where `team_name` matches `session-<lead prefix>`. Until then it shows as a plain session in the project, not as a guessed teammate. Its permission prompts produce no `PermissionRequest`, so the bridge cannot answer them. On the lead's `worker_permission_prompt` notification, the **lead** turns red with "for: pip". The name is parsed from the message and the attribution is labelled heuristic. The card says "answer in the lead's terminal" and offers no Allow or Deny.

**Tradeoff:** in-process teams get full fidelity. Split-pane teams lose two things: (a) a short window, before the first idle, in which a teammate is not yet linked to its team, and (b) all permission answering, plus a name taken from English notification text that a Claude Code update could change. The alternative is to link split-pane teammates at spawn by matching the next `SessionStart` in the same `cwd` after `teammate_spawned`. That closes the window but is a guess when spawns overlap, and the constitution forbids merging identities on a guess. Recommend the honest version and a doc note that in-process mode gives the best Taskville experience.
