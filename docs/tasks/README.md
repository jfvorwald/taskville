# Task reports

One file per ticket, named after its key: `docs/tasks/M1.05.md`. Written by the teammate who did the work, in the ticket's own PR. The lead folds the outcome into [STATUS.md](../STATUS.md) after review and merge, so parallel teammates never edit the same file.

```markdown
# M1.05: <ticket title> (#<issue>)

- **Result:** done | partial | blocked
- **PR:** #<number> · **roborev:** pass (job <id>) | findings fixed in <commit>
- **Checks run:** <commands and results>
- **NOT RUN:** <anything skipped, and why>
- **Measurements:** <numbers with the command that produced them, or "none">
- **Decisions needed:** <links to decision tickets, or "none">
- **Review outcome:** passed first review | one fix round | more than one fix round | escalated · findings: high <n>, medium <n>, low <n>
- **Lessons:** <copied to docs/LESSONS.md by the lead>
```
