// The recorded GitHub data a retro is computed from. `collect.ts` builds it with `gh`; everything
// else is a pure function of it. Only the fields the report needs are kept, so a recorded snapshot
// carries no logins, names, emails, or avatars.

export type IssueRecord = {
  number: number;
  title: string;
  state: "open" | "closed";
  /** GitHub's `state_reason`: `completed`, `not_planned`, `reopened`, or null. */
  stateReason: string | null;
  createdAt: string;
  closedAt: string | null;
  labels: string[];
};

export type PullRecord = {
  number: number;
  title: string;
  headRef: string;
  state: "open" | "closed";
  createdAt: string;
  mergedAt: string | null;
  /** Earliest author date among the PR's commits: the first commit on the ticket branch. */
  firstCommitAt: string | null;
};

/** Board (GitHub project) fields of one issue. */
export type BoardFields = { size?: string; lane?: string; priority?: string; phase?: string };

export type RunRecord = {
  id: number;
  event: string;
  headBranch: string;
  status: string;
  /** Conclusion of the latest attempt. */
  conclusion: string | null;
  runAttempt: number;
  createdAt: string;
  /** Conclusions of earlier attempts (1 to runAttempt - 1), when the run was re-run. */
  earlierAttempts: (string | null)[];
};

export type MilestoneRecord = {
  number: number;
  title: string;
  createdAt: string;
  dueOn: string | null;
};

export type Snapshot = {
  milestone: MilestoneRecord;
  issues: IssueRecord[];
  pulls: PullRecord[];
  /** Board fields keyed by issue number (as a string, since this is JSON). */
  board: Record<string, BoardFields>;
  runs: RunRecord[];
  /** `docs/tasks/<KEY>.md` contents keyed by ticket key, for tickets that have one. */
  taskReports: Record<string, string>;
  /** When the snapshot was recorded with `--record`; the golden test renders as of this time. */
  recordedAt?: string;
};
