// The network part: reads one milestone's data through `gh` (execFile, no shell) and reduces it
// to a Snapshot. Everything after this is pure and tested against a recorded snapshot.

import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  milestoneKeyOf,
  redactSnapshot,
  reduceBoard,
  reduceIssue,
  reduceMilestone,
  reducePull,
  reduceRun,
  ticketKeyOf,
} from "./reduce.ts";
import type { Snapshot } from "./types.ts";

type Raw = { [key: string]: unknown };

const run = promisify(execFile);

/** Raw `gh` output, or null when GitHub answers 404. */
async function ghText(args: string[]): Promise<string | null> {
  try {
    return (await run("gh", args, { maxBuffer: 64 * 1024 * 1024 })).stdout;
  } catch (error) {
    if (/HTTP 404|Not Found/.test(String((error as { stderr?: unknown }).stderr ?? error)))
      return null;
    throw error;
  }
}

async function gh(args: string[]): Promise<unknown> {
  const { stdout } = await run("gh", args, { maxBuffer: 64 * 1024 * 1024 });
  return JSON.parse(stdout);
}

/** Every page of a REST list endpoint, flattened. `pick` selects the list inside a page object. */
async function list(path: string, pick?: string): Promise<Raw[]> {
  const pages = (await gh(["api", "--paginate", "--slurp", path])) as unknown[];
  return pages.flatMap((page) =>
    pick === undefined ? (page as Raw[]) : ((page as Raw)[pick] as Raw[]),
  );
}

const BOARD_QUERY = `query($owner: String!, $number: Int!, $after: String) {
  repositoryOwner(login: $owner) {
    ... on ProjectV2Owner {
      projectV2(number: $number) {
        items(first: 100, after: $after) {
          pageInfo { hasNextPage endCursor }
          nodes {
            content { ... on Issue { number repository { nameWithOwner } } }
            fieldValues(first: 30) {
              nodes {
                ... on ProjectV2ItemFieldSingleSelectValue {
                  name
                  field { ... on ProjectV2SingleSelectField { name } }
                }
              }
            }
          }
        }
      }
    }
  }
}`;

async function boardItems(owner: string, project: number): Promise<Raw[]> {
  const items: Raw[] = [];
  let after: string | null = null;
  do {
    const args = [
      "api",
      "graphql",
      "-f",
      `query=${BOARD_QUERY}`,
      "-F",
      `owner=${owner}`,
      "-F",
      `number=${project}`,
    ];
    if (after !== null) args.push("-F", `after=${after}`);
    const response = (await gh(args)) as Raw;
    const page = ((((response.data as Raw).repositoryOwner as Raw).projectV2 as Raw).items ??
      {}) as Raw;
    items.push(...((page.nodes ?? []) as Raw[]));
    const info = page.pageInfo as Raw | undefined;
    after = info?.hasNextPage === true ? String(info.endCursor) : null;
  } while (after !== null);
  return items;
}

export type CollectOptions = {
  key: string;
  /** Board (GitHub project v2) number under the repository owner. */
  project: number;
  now: Date;
};

export async function collect({ key, project, now }: CollectOptions): Promise<Snapshot> {
  const repo = (
    await run("gh", ["repo", "view", "--json", "nameWithOwner", "--jq", ".nameWithOwner"])
  ).stdout.trim();
  const owner = repo.split("/")[0] ?? "";

  const milestones = await list(`repos/${repo}/milestones?state=all&per_page=100`);
  const rawMilestone = milestones.find((m) => milestoneKeyOf(String(m.title)) === key);
  if (rawMilestone === undefined) throw new Error(`No milestone titled "${key} ..." in ${repo}`);
  const milestone = reduceMilestone(rawMilestone);

  const issues = (
    await list(`repos/${repo}/issues?milestone=${milestone.number}&state=all&per_page=100`)
  )
    .filter((issue) => issue.pull_request === undefined)
    .map(reduceIssue);
  const ticketKeys = new Set(issues.flatMap((i) => ticketKeyOf(i.title) ?? []));

  const rawPulls = (await list(`repos/${repo}/pulls?state=all&per_page=100`)).filter((p) =>
    ticketKeys.has(ticketKeyOf(String(p.title)) ?? ""),
  );
  const pulls = await Promise.all(
    rawPulls.map(async (p) =>
      reducePull(p, await list(`repos/${repo}/pulls/${p.number}/commits?per_page=100`)),
    ),
  );

  const branches = new Set([...ticketKeys, ...pulls.map((p) => p.headRef)]);
  const since = milestone.createdAt.slice(0, 10);
  const rawRuns = (
    await list(`repos/${repo}/actions/runs?per_page=100&created=>=${since}`, "workflow_runs")
  ).filter((r) => branches.has(String(r.head_branch)));
  const runs = await Promise.all(
    rawRuns.map(async (r) => {
      const attempts: Raw[] = [];
      for (let n = 1; n < Number(r.run_attempt ?? 1); n += 1) {
        attempts.push(
          (await gh(["api", `repos/${repo}/actions/runs/${r.id}/attempts/${n}`])) as Raw,
        );
      }
      return reduceRun(r, attempts);
    }),
  );

  const board = reduceBoard(await boardItems(owner, project), repo);
  const ticketNumbers = new Set(issues.map((i) => String(i.number)));
  // Task reports come from the default branch on GitHub, not the local checkout, which may be
  // behind or on another branch.
  const taskReports: Record<string, string> = {};
  for (const ticketKey of [...ticketKeys].sort()) {
    const report = await ghText([
      "api",
      "-H",
      "Accept: application/vnd.github.raw+json",
      `repos/${repo}/contents/docs/tasks/${ticketKey}.md`,
    ]);
    if (report !== null) taskReports[ticketKey] = report;
  }

  // The owner's login appears in links inside task reports; the report never needs it.
  return redactSnapshot<Snapshot>(
    {
      milestone,
      issues,
      pulls,
      board: Object.fromEntries(Object.entries(board).filter(([n]) => ticketNumbers.has(n))),
      runs,
      taskReports,
      recordedAt: now.toISOString(),
    },
    [owner],
  );
}
