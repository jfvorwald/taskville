# Milestone retrospectives

Every milestone ends with a retrospective before its review gate. The owner reads the retro as part of the gate review. Lessons are recorded continuously in [LESSONS.md](../LESSONS.md), not only at the end.

## What gets recorded, and when

| When | Who | What |
| --- | --- | --- |
| Any surprise during a ticket | The agent who hit it | A lesson entry in the PR's **Lessons** section (see the PR template). The lead copies it into [LESSONS.md](../LESSONS.md) when the PR merges. |
| A failed review, a fix that failed twice, a flake, an escalation | The lead | A lesson entry in [LESSONS.md](../LESSONS.md) the same day |
| All tickets of a milestone closed | The lead, via the milestone's retro ticket | `docs/retros/M<n>.md` generated from GitHub data with `pnpm retro M<n>`, plus the written analysis, then linked in the gate summary |

## The report

`pnpm retro M<n>` (built in ticket M1.19) reads issues, pull requests, reviews, and CI runs for the milestone from GitHub and writes `docs/retros/M<n>.md` from [TEMPLATE.md](TEMPLATE.md). Charts are Mermaid, so they render directly on GitHub with no extra tooling. Agents fill in only the written sections; the numbers and charts are never typed by hand.

Charts in every report:

1. **Timeline**: a Gantt chart of every ticket, grouped by lane, from first commit to merge. Shows how much really ran in parallel.
2. **Burn-down**: open tickets per day against the ideal line.
3. **Parallelism**: tickets in progress per day.
4. **Cycle time by size**: average hours from first commit to merge for S, M, and L tickets, so sizing can be calibrated.
5. **Review outcomes**: passed first review, needed one fix round, escalated.
6. **Quality signals**: CI failures, flakes, re-runs, tests NOT RUN, security findings by severity.
7. **Plan versus actual**: tickets planned, added mid-milestone, split, or dropped.

## Data sources and honesty

- Start time is the first commit on the ticket's branch; end time is the merge. The board's status history is not exposed by the GitHub API, so it is not used.
- Anything the script cannot measure is printed as "not measured", never estimated.
- Agent token or cost data is included only if the run recorded it.
