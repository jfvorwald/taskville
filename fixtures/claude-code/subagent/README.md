# Subagent hook streams (spike S-2)

Recorded 2026-10-30 with Claude Code 2.1.312 (`claude -p`, model `claude-haiku-5-5`) in a throwaway repo. Findings: [docs/spikes/S-2-crews.md](../../../docs/spikes/S-2-crews.md).

Each line is one hook call in the order the recorder received it:

```json
{"seq": 0, "offset_ms": 0.0, "input": { "...raw hook JSON exactly as Claude Code sent it..." }}
```

`offset_ms` is the receive time relative to the first line. Hooks were async command hooks, so receive order is not guaranteed to match the order the hooks fired.

| File | Scenario |
| --- | --- |
| `parallel.jsonl` | The main session calls Agent twice in one message: subagent A Reads and Edits `notes.txt` and runs `wc -l`, and subagent B Writes `hello.txt` and runs `cat`. Both run in the background (`status: async_launched`). Then the main session runs a failing `cat missing.txt` (`PostToolUseFailure`). Shows parent `Stop` firing while subagents still run, and a new `UserPromptSubmit` when they report back. |
| `nested.jsonl` | The main session launches custom agent `outer` (background), which synchronously launches `inner`, which runs `echo nested-ok`. Shows `PreToolUse` Agent carrying the caller's `agent_id` (the parent link), and the synchronous Agent `tool_response` (`status: completed`, `toolStats`, `usage`). |

Redactions: the scratch directory is `/tmp/spike-s2`, the home directory is `/Users/dev`, the per-user temp root is `/tmp/claude-uid`, and project slugs in paths are rewritten to match. IDs (`session_id`, `agent_id`, `tool_use_id`, `prompt_id`) are the real random values.
