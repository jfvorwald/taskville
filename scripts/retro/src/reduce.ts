// Pure reducers from GitHub API responses to the snapshot records in types.ts. They copy only
// the fields the report uses, which is also what keeps a recorded snapshot free of personal data.

import type { BoardFields, IssueRecord, MilestoneRecord, PullRecord, RunRecord } from "./types.ts";

type Raw = { [key: string]: unknown };

/** `[M1.05] Title` -> `M1.05`; gates (`[G1]`), decisions, and status PRs have no ticket key. */
export function ticketKeyOf(title: string): string | null {
  return /^\[(M\d+\.[A-Za-z0-9]+)\]/.exec(title)?.[1] ?? null;
}

/** `M1 Headless foundation` -> `M1`. */
export function milestoneKeyOf(title: string): string | null {
  return /^(M\d+)\b/.exec(title)?.[1] ?? null;
}

const str = (value: unknown): string => (typeof value === "string" ? value : "");
const strOrNull = (value: unknown): string | null => (typeof value === "string" ? value : null);

export function reduceMilestone(raw: Raw): MilestoneRecord {
  return {
    number: Number(raw.number),
    title: str(raw.title),
    createdAt: str(raw.created_at),
    dueOn: strOrNull(raw.due_on),
  };
}

export function reduceIssue(raw: Raw): IssueRecord {
  const labels = Array.isArray(raw.labels) ? raw.labels : [];
  return {
    number: Number(raw.number),
    title: str(raw.title),
    state: raw.state === "closed" ? "closed" : "open",
    stateReason: strOrNull(raw.state_reason),
    createdAt: str(raw.created_at),
    closedAt: strOrNull(raw.closed_at),
    labels: labels.map((label) => str((label as Raw).name)).filter((name) => name !== ""),
  };
}

/** `commits` is the PR's commit list; the earliest author date is the branch's first commit. */
export function reducePull(raw: Raw, commits: Raw[]): PullRecord {
  const dates = commits
    .map((c) => str(((c.commit as Raw | undefined)?.author as Raw | undefined)?.date))
    .filter((d) => d !== "")
    .sort();
  return {
    number: Number(raw.number),
    title: str(raw.title),
    headRef: str((raw.head as Raw | undefined)?.ref),
    state: raw.state === "closed" ? "closed" : "open",
    createdAt: str(raw.created_at),
    mergedAt: strOrNull(raw.merged_at),
    firstCommitAt: dates[0] ?? null,
  };
}

/** `attempts` are the run's earlier attempts (attempt 1 to run_attempt - 1), in any order. */
export function reduceRun(raw: Raw, attempts: Raw[]): RunRecord {
  return {
    id: Number(raw.id),
    event: str(raw.event),
    headBranch: str(raw.head_branch),
    status: str(raw.status),
    conclusion: strOrNull(raw.conclusion),
    runAttempt: Number(raw.run_attempt ?? 1),
    createdAt: str(raw.created_at),
    earlierAttempts: [...attempts]
      .sort((a, b) => Number(a.run_attempt) - Number(b.run_attempt))
      .map((a) => strOrNull(a.conclusion)),
  };
}

const BOARD_FIELDS: Record<string, keyof BoardFields> = {
  Size: "size",
  Lane: "lane",
  Priority: "priority",
  Phase: "phase",
};

/** Project (v2) items from GraphQL to board fields keyed by issue number, for one repository. */
export function reduceBoard(items: Raw[], repository: string): Record<string, BoardFields> {
  const board: Record<string, BoardFields> = {};
  for (const item of items) {
    const content = item.content as Raw | undefined;
    const repo = (content?.repository as Raw | undefined)?.nameWithOwner;
    if (typeof content?.number !== "number" || repo !== repository) continue;
    const fields: BoardFields = {};
    const nodes = ((item.fieldValues as Raw | undefined)?.nodes ?? []) as Raw[];
    for (const node of nodes) {
      const fieldName = str((node.field as Raw | undefined)?.name);
      const key = BOARD_FIELDS[fieldName];
      if (key !== undefined && typeof node.name === "string") fields[key] = node.name;
    }
    board[String(content.number)] = fields;
  }
  return board;
}

const escapeRegExp = (text: string) => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Replaces each word (for example the repository owner's login, which task reports mention in
 * links) with "redacted" in every string of the snapshot, case-insensitively. Returns a copy.
 */
export function redactSnapshot<T>(snapshot: T, words: string[]): T {
  const patterns = words.filter((w) => w !== "").map((w) => new RegExp(escapeRegExp(w), "gi"));
  if (patterns.length === 0) return snapshot;
  const walk = (value: unknown): unknown => {
    if (typeof value === "string")
      return patterns.reduce((s, p) => s.replace(p, "redacted"), value);
    if (Array.isArray(value)) return value.map(walk);
    if (typeof value === "object" && value !== null) {
      return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, walk(v)]));
    }
    return value;
  };
  return walk(snapshot) as T;
}
