# Tool call Pre/Post pairs (spike S-2)

`pairs.jsonl` is extracted from the subagent and team streams next to it (no separate recording). It has one line per finished call of Edit, Write, Bash, Agent and SendMessage:

```json
{"scenario": "team/in-process.jsonl", "tool_name": "Edit", "post_event": "PostToolUse", "pre": { "...PreToolUse input..." }, "post": { "...PostToolUse or PostToolUseFailure input..." }}
```

`pre` and `post` are matched by `tool_use_id`. What the pairs cover:

- **Edit**: `tool_response` has `filePath`, `oldString`, `newString`, `originalFile` (the whole file before the edit), `structuredPatch` hunks with real line numbers, `userModified` and `replaceAll`. One pair also has `contentNotInModelContext`.
- **Write** (new file): `type: "create"`, `content`, `structuredPatch: []`, `originalFile: null`. There is no pair for overwriting an existing file.
- **Bash**: success gives `stdout`, `stderr`, `interrupted`, `isImage` and `noOutputExpected`, with no exit code. Failure (`cat missing.txt` in `subagent/parallel.jsonl`) is a `PostToolUseFailure` with no `tool_response`, and the exit code is only inside the `error` string.
- **Agent**: background launch (`async_launched`), synchronous completion (`completed`, `toolStats`, `usage`), and teammate spawn (`teammate_spawned`, `teammate_id`, `is_splitpane`, `tmux_pane_id`).
- **SendMessage**: teammate messages (`routing`, where `routing.content` can be truncated) and shutdown request and response traffic. `pre.tool_input` can hold extra normalized fields that `post.tool_input` does not.

Redactions are the same as in [../subagent/README.md](../subagent/README.md).
