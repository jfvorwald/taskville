# Agent teams and subagents

Taskville shows Claude Code's subagents and agent teams as part of the city.

- **A subagent** is a smaller bot that walks out of its parent's door and returns when it finishes. Taskville links it to the parent when the subagent starts and closes it when it stops.
- **A teammate** is a full-size bot that works beside its lead. Taskville marks the agent that starts a team as the lead when agent teams are enabled in Claude Code.
- In the agent panel, the **Crew** tab lists the lead's subagents and teammates. Selecting one highlights its whole family in the city.

Notes:

- The mapping comes from the hook fields Claude Code sends (`session_id`, `agent_id`, `agent_type`, and `teammate_name`). If a teammate does not appear, check that its hooks are installed where Claude Code reads them (see [install](install.md)), then run `taskville doctor`.
- A permission request from a subagent or teammate is answered the same way as any other, in the same card.
- Taskville does not start, schedule, or coordinate agents. It only observes them and relays your answers.
- Teams are supported as far as the hook data allows. Anything Claude Code does not report through hooks is not shown.
