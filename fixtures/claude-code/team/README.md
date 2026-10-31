# Agent-team hook streams (spike S-2)

Recorded 2026-10-30 with Claude Code 2.1.312, interactive sessions in a private tmux server, `CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1`, model `claude-haiku-5-5`, lead in manual permission mode, throwaway repo. Teams do not spawn under `claude -p`. Findings: [docs/spikes/S-2-crews.md](../../../docs/spikes/S-2-crews.md).

Line format matches [../subagent/README.md](../subagent/README.md): `{"seq", "offset_ms", "input"}`, where `input` is the raw hook JSON. A file holds every session's hooks (the lead's and each teammate's) interleaved in receive order.

The scenario in every file: the lead spawns teammates `pip` and `bo`. pip Writes `team-pip.txt`, runs a Bash command, and sends bo "hi bo". bo Reads and Edits `notes.txt`, runs `wc -l`, waits for pip, and replies "hi pip". The lead then shuts the team down with `shutdown_request` messages.

| File | Display mode | What it shows |
| --- | --- | --- |
| `in-process.jsonl` | in-process (default) | Teammates share the lead's `session_id` and are identified by `agent_id` (`apip-…`, `abo-…`) with `agent_type` = name. Each turn has a `SubagentStart`, `SubagentStop` and `TeammateIdle`. pip's `touch perm-pip.txt` hits an ask rule and fires a **`PermissionRequest` carrying pip's `agent_id`**, which was answered in the lead's terminal, followed by a lead `Notification` (`permission_prompt`). It also has `SubagentStop` events with `agent_type: ""` from internal helper agents with no `SubagentStart`. |
| `split-pane.jsonl` | tmux split panes | Each teammate is its own session (own `session_id`, `SessionStart`, `Stop`, `TeammateIdle`, `SessionEnd`) with no `agent_id`. pip's `touch` prompt fires **no `PermissionRequest`**. The lead instead gets a `Notification` with `notification_type: "worker_permission_prompt"` and the message "pip needs permission for Bash". Teammates report `permission_mode: "auto"`. The lead's `ListAgents` output is redacted. |
| `split-pane-speculative.jsonl` | tmux split panes | An earlier split-pane run with no permission prompt: pip ran `touch perm-pip.txt` before the ask rule was added, and the teammate's auto mode allowed it. Teammate sessions carry `agent_type: "general-purpose"`, because the lead passed `subagent_type`. An internal helper agent fires `PreToolUse` Bash with an `agent_id` and **no matching Post**. |

Not in these streams: `TaskCreated` and `TaskCompleted` (the task tools were not available in 2.1.312 for these sessions), plus `Elicitation`, `StopFailure` and `PermissionDenied`.

Redactions are the same as in [../subagent/README.md](../subagent/README.md). In addition, `ListAgents` responses have the machine's peer session list replaced with `peer-N` rows.
