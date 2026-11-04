# OTLP fixtures (M5.12, #104)

These payloads are SYNTHESIZED from Claude Code's documented OpenTelemetry export. They are not
recordings of a live session. Decision #360 (D1 default) kept the live recording out: a live
`claude` run writes a folder-trust entry to `~/.claude.json`. A recording script belongs in
`tests/e2e/claude-code-telemetry/` and is NOT RUN.

What is taken from the documentation: the metric names `claude_code.token.usage` (attribute
`type`: `input`, `output`, `cacheRead`, `cacheCreation`) and `claude_code.cost.usage` (USD),
delta temporality counters, the `session.id` and `model` attributes, the `claude_code.api_request`
log event with `cost_usd` and the four token counts, and the OTLP/HTTP JSON envelope
(`resourceMetrics` / `resourceLogs`, int64 values as strings, doubles as numbers).

What is an assumption, to be checked against a real recording (decision #360 alternatives A or B):
the `agent_id` and `parent_agent_id` data point attributes on subagent work (the ticket and
ARCHITECTURE.md 5.1 name them; the exact spelling and which events carry them are unconfirmed), and
`agent_id` and `parent_agent_id` on `claude_code.api_request` records.

The session and agent IDs reuse the S-2 recordings in `fixtures/claude-code/subagent` so a test can
line telemetry up with hook-derived agents (`claude-code:<session>[:<agent_id>]`).

| File | Contents |
| --- | --- |
| `metrics-parallel.json` | Session `1469cdbe-...`: the lead (no `agent_id`) and two sibling subagents; plus `claude_code.session.count` and `claude_code.lines_of_code.count`, which Taskville ignores |
| `metrics-nested.json` | Session `6effc000-...`: an outer subagent and its own subagent, which names the outer in `parent_agent_id` |
| `logs-api-requests.json` | `claude_code.api_request` records for subagent `a` of the parallel session (also in the metrics), for a session that exports logs only, and one `claude_code.tool_result` record that is ignored |

Regenerate by editing the JSON by hand; there is no generator in the repository.
