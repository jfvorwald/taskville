---
name: codex-handoff
description: Use when the user asks the integration lead for an independent ticket or a ready-to-paste prompt to run in a separate Codex T3 thread or IDE while the existing team continues unrelated work.
---

# Independent Codex handoff

Reserve one bounded ticket for a user-operated Codex session and return its launch brief. This invocation prepares the handoff; it does not launch a thread, delegate, or implementation worker. Continue unrelated work only within existing authorization. A paused wave stays paused.

## Choose and reserve

1. Read the current repository instructions and the live issue contract. Reconcile existing PRs, worktrees, assignments, and reservations before selecting work. Prefer an existing ready ticket with closed dependencies, clear acceptance checks, and disjoint source AND test paths. Honor a user-named ticket if it is eligible.
2. Exclude active/reserved work, completed work, work whose prerequisite review gate has not been closed by the owner, and tickets with unresolved blockers. If nothing qualifies, explain the specific blocker and offer a read-only investigation as an option. Do not silently expand scope or assign a conflicting ticket.
3. Resolve the baseline to a full commit SHA from the integration branch. Include its branch name. Never include uncommitted changes as though the worker will inherit them. A resumed ticket keeps its existing worktree/branch and commits; identify the ownership transfer instead of creating duplicate work.
4. Record the reservation BEFORE returning the launch prompt. Use the project's established assignment ledger if it has one. Otherwise the integration lead writes `docs/handoffs/<KEY>.md`, using the issue number when no ticket key exists. This is a lead-owned reservation, not an update to a worker's task report. Do not start the dormant CTO hierarchy or create tickets.md just for this skill. Leave user-level config untouched.

Reservation fields:

| Field | Required value |
| --- | --- |
| Ticket | Key and issue URL |
| State | reserved, started, review, merged, or released |
| Owner | user-operated Codex; session link when supplied |
| Integration lead | current coordinating session link when available; otherwise identify this session and mark link unavailable |
| Base | integration branch and full commit SHA |
| Workspace | new isolated workspace required, or existing branch/worktree for takeover |
| Expected starting HEAD | base SHA for new work; preserved worker HEAD for takeover, recorded separately from integration baseline |
| Owns | exact source, test, and report paths |
| Shared files | dependencies, integration order, or explicit statement that none are needed |
| Model | provider, full model ID, effort, and supported service tier |
| Checks | acceptance command and required repository review/check commands |
| Deadline | supplied cutoff/checkpoint time with timezone, or explicitly not supplied |
| Next handoff | PR URL, HEAD SHA, checks, review evidence, NOT RUN, unfinished work, blockers |

The reservation removes the ticket and its paths from the lead's available assignment pool. Recheck reservations before subsequent assignments. Shared files include exports, lockfiles, manifests, fixtures, generated snapshots, and reducer versions; separate worktrees do not eliminate conflicts in these files. Resolve overlap before launch. If a handoff file cannot be written, report that reservation failed and label the prompt unreserved; do not claim exclusive ownership.

## Return the brief

Give the user, in order:

- The reserved issue, reservation location, owned paths, baseline, and what the lead can continue independently.
- Launch settings: T3 Code, Codex provider, isolated worktree workspace. Apply the user's approved model policy. For ordinary Taskville work: `gpt-6.1-sol`, medium reasoning effort, default service tier if offered. Security work uses high; other choices follow the approved policy. Check live availability if selecting a different model; do not substitute silently.
- One ready-to-paste prompt, filled from verified facts. Mark unknowns explicitly. A missing deadline does not authorize inventing a usage reset. Preserve an already-authorized stop time.

Use this prompt shape:

```text
Own <KEY and issue URL> exclusively for this handoff. Integration lead: <lead>.
Reservation: <path>; read it and the repository instructions first.

Baseline: <branch>, <full SHA>. Workspace: <new isolated T3 worktree, or existing takeover workspace>.
Expected starting HEAD: <base SHA for new work, or preserved worker HEAD for takeover>.
Before editing, verify the actual workspace and HEAD against the expected starting HEAD; report a mismatch.
Owns: <source paths>, <test paths>, <task report path>.
Shared-file dependencies and integration order: <facts>.
Acceptance: <concrete result and exact check command>.

Use Codex <model>, effort <level>, service tier <tier if supported>.
Test first; make the smallest change. Follow the issue and repository review/check rules:
<exact relevant commands>. Preserve existing work and report checks not run.
No subagents, merges, shared status edits, production changes, or additional tickets.
Report an ownership conflict before changing another worker's paths.

Stop assigning/starting work at <known time and timezone, or deadline not supplied>.
Checkpoint by <known time, or deadline not supplied>. If no deadline was supplied,
complete only this ticket and stop at the PR; do not infer a five-hour usage window.

Return PR URL, branch/worktree, final HEAD SHA, checks and results, review job/outcome,
NOT RUN items, unfinished work, and blockers. Freeze the branch after this handoff
until the integration lead requests another change. Do not merge.
```

For a new T3 session, the USER selects the worktree workspace before sending the prompt. A separate thread or IDE window sharing the lead's checkout is not isolated. For an IDE, open the reserved worktree folder. For takeover, ensure the former writer has stopped before the new writer edits. A prompt does not bind a T3 thread to a shell-created worktree.

## Accept the result

On the user's return, verify the PR's actual head and checks against the final-head report. Mark the reservation review and keep it exclusive while fixes remain. The integration lead alone merges, records shared status, and marks merged. On cancellation, preserve commits, diffs, and the handoff before marking released; do not delete worktrees automatically.

Invocation examples: `/codex-handoff`, `/codex-handoff #207`, or “Give me an independent Codex ticket.” In Codex, use `$codex-handoff` when discovered. Listing examples does not execute them.
