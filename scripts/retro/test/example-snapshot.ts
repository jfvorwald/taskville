import type { Snapshot } from "../src/types.ts";

/**
 * A small hand-built milestone with every case the model handles: done, dropped, in progress, not
 * started, added mid-milestone, a superseded PR, a lead status PR, a gate, a decision ticket, CI
 * failures, a flaky re-run, a plain re-run, and runs that are not on ticket branches.
 */
export const NOW = new Date("2026-01-03T12:00:00Z");

const issue = (
  number: number,
  title: string,
  state: "open" | "closed",
  createdAt: string,
  closedAt: string | null = null,
  stateReason: string | null = state === "closed" ? "completed" : null,
) => ({ number, title, state, stateReason, createdAt, closedAt, labels: [] });

const run = (
  id: number,
  headBranch: string,
  conclusion: string | null,
  runAttempt = 1,
  earlierAttempts: (string | null)[] = [],
  event = "pull_request",
) => ({
  id,
  event,
  headBranch,
  status: "completed",
  conclusion,
  runAttempt,
  createdAt: "2026-01-02T00:00:00Z",
  earlierAttempts,
});

export const example: Snapshot = {
  milestone: { number: 9, title: "M9 Example", createdAt: "2026-01-01T00:00:00Z", dueOn: null },
  issues: [
    issue(1, "[M9.01] Alpha tooling", "closed", "2026-01-01T00:00:00Z", "2026-01-02T12:00:00Z"),
    issue(2, "[M9.02] Beta: domain work", "closed", "2026-01-01T00:00:00Z", "2026-01-03T10:00:00Z"),
    issue(3, "[M9.03] Gamma", "open", "2026-01-01T00:00:00Z"),
    issue(
      4,
      "[M9.04] Delta",
      "closed",
      "2026-01-01T00:00:00Z",
      "2026-01-02T00:00:00Z",
      "not_planned",
    ),
    issue(5, "[M9.05] Epsilon", "open", "2026-01-02T15:00:00Z"),
    issue(6, "[G9] Review gate G9", "open", "2026-01-01T00:00:00Z"),
    issue(7, "Decision: something", "open", "2026-01-02T00:00:00Z"),
  ],
  pulls: [
    {
      number: 10,
      title: "[M9.01] Alpha tooling",
      headRef: "M9.01",
      state: "closed",
      createdAt: "2026-01-01T11:00:00Z",
      mergedAt: "2026-01-02T12:00:00Z",
      firstCommitAt: "2026-01-01T10:00:00Z",
    },
    {
      number: 11,
      title: "[M9.02] Beta: domain work",
      headRef: "M9.02",
      state: "closed",
      createdAt: "2026-01-02T11:00:00Z",
      mergedAt: "2026-01-03T10:00:00Z",
      firstCommitAt: "2026-01-02T10:00:00Z",
    },
    {
      number: 9,
      title: "[M9.02] Beta, first attempt",
      headRef: "M9.02-old",
      state: "closed",
      createdAt: "2026-01-01T09:00:00Z",
      mergedAt: null,
      firstCommitAt: "2026-01-01T08:00:00Z",
    },
    {
      number: 12,
      title: "[M9.03] Gamma",
      headRef: "M9.03",
      state: "open",
      createdAt: "2026-01-03T09:00:00Z",
      mergedAt: null,
      firstCommitAt: "2026-01-03T08:00:00Z",
    },
    {
      number: 13,
      title: "Status: fold in M9.01",
      headRef: "lead/status-1",
      state: "closed",
      createdAt: "2026-01-02T12:30:00Z",
      mergedAt: "2026-01-02T12:40:00Z",
      firstCommitAt: "2026-01-02T12:20:00Z",
    },
  ],
  board: {
    "1": { size: "S", lane: "Infra", priority: "P1", phase: "M9 Example" },
    "2": { size: "M", lane: "Domain", priority: "P0", phase: "M9 Example" },
    "3": { size: "L", lane: "Domain", priority: "P0", phase: "M9 Example" },
    "4": { size: "S", lane: "Domain" },
    "5": { size: "M" },
  },
  runs: [
    run(100, "M9.01", "failure"),
    run(101, "M9.01", "success"),
    run(102, "M9.02", "success", 2, ["failure"]),
    run(103, "M9.02", "success", 2, ["success"]),
    run(104, "M9.03", "cancelled"),
    run(105, "lead/status-1", "failure"),
    run(106, "main", "failure", 1, [], "push"),
  ],
  taskReports: {
    "M9.01":
      "# M9.01\n\n- **PR:** #10 · **roborev:** pass (job 1, pre_merge panel, no findings)\n- **NOT RUN:** none\n",
    "M9.02":
      "# M9.02\n\n- **PR:** #11 · **roborev:** panel job 2 (1 high) fixed in abc1234; re-review job 3 pass\n- **NOT RUN:** e2e (none exist yet)\n",
  },
};
