import { describe, expect, it } from "vitest";
import {
  milestoneKeyOf,
  redactSnapshot,
  reduceBoard,
  reduceIssue,
  reduceMilestone,
  reducePull,
  reduceRun,
  ticketKeyOf,
} from "../src/reduce.ts";
import { example } from "./example-snapshot.ts";

// Trimmed GitHub API responses in the shapes `gh api` returns, with personal fields redacted to
// placeholders. Reduction must drop every field the report does not use.
const user = { login: "owner-login", id: 1, avatar_url: "https://example.invalid/a.png" };

describe("keys", () => {
  it.each([
    ["[M1.05] Protocol v1", "M1.05"],
    ["[M1.RT] Retrospective", "M1.RT"],
    ["[M12.3] Later", "M12.3"],
    ["[G1] Review gate G1", null],
    ["Status: fold in M1.05", null],
    ["Decision: project registry", null],
    ["M1.05 without brackets", null],
  ])("ticketKeyOf(%j) is %j", (title, key) => {
    expect(ticketKeyOf(title)).toBe(key);
  });

  it("matches a milestone by its key prefix", () => {
    expect(milestoneKeyOf("M1 Headless foundation")).toBe("M1");
    expect(milestoneKeyOf("M8 Post-release: imports")).toBe("M8");
    expect(milestoneKeyOf("Backlog")).toBeNull();
  });
});

describe("reducers", () => {
  it("reduces a milestone", () => {
    expect(
      reduceMilestone({
        number: 1,
        title: "M1 Headless foundation",
        created_at: "2026-10-31T00:09:36Z",
        due_on: null,
        creator: user,
        open_issues: 13,
      }),
    ).toEqual({
      number: 1,
      title: "M1 Headless foundation",
      createdAt: "2026-10-31T00:09:36Z",
      dueOn: null,
    });
  });

  it("reduces an issue to the fields the report uses", () => {
    expect(
      reduceIssue({
        number: 5,
        title: "[M1.05] Protocol v1",
        state: "closed",
        state_reason: "completed",
        created_at: "2026-10-31T00:10:15Z",
        closed_at: "2026-10-31T01:56:10Z",
        labels: [{ name: "lane:domain", color: "fff" }],
        user,
        assignees: [user],
        body: "free text",
      }),
    ).toEqual({
      number: 5,
      title: "[M1.05] Protocol v1",
      state: "closed",
      stateReason: "completed",
      createdAt: "2026-10-31T00:10:15Z",
      closedAt: "2026-10-31T01:56:10Z",
      labels: ["lane:domain"],
    });
  });

  it("takes a PR's first commit as the earliest author date, which survives rebases", () => {
    const commit = (author: string, committer: string) => ({
      sha: "0".repeat(40),
      commit: {
        author: { name: "Redacted", email: "redacted@example.invalid", date: author },
        committer: { name: "Redacted", email: "redacted@example.invalid", date: committer },
        message: "M1.05: x",
      },
      author: user,
    });
    const pull = reducePull(
      {
        number: 123,
        title: "[M1.05] Protocol v1",
        state: "closed",
        created_at: "2026-10-31T01:50:00Z",
        merged_at: "2026-10-31T01:56:08Z",
        head: { ref: "M1.05", sha: "1".repeat(40), user },
        user,
        body: "Closes #5",
      },
      [
        commit("2026-10-31T01:45:11Z", "2026-10-31T01:51:02Z"),
        commit("2026-10-31T01:38:57Z", "2026-10-31T01:51:02Z"),
      ],
    );
    expect(pull).toEqual({
      number: 123,
      title: "[M1.05] Protocol v1",
      headRef: "M1.05",
      state: "closed",
      createdAt: "2026-10-31T01:50:00Z",
      mergedAt: "2026-10-31T01:56:08Z",
      firstCommitAt: "2026-10-31T01:38:57Z",
    });
    expect(JSON.stringify(pull)).not.toMatch(/login|email|Redacted/);
  });

  it("leaves the first commit unmeasured when a PR lists no commits", () => {
    expect(
      reducePull(
        {
          number: 1,
          title: "t",
          state: "open",
          created_at: "x",
          merged_at: null,
          head: { ref: "M1.01" },
        },
        [],
      ).firstCommitAt,
    ).toBeNull();
  });

  it("reduces a workflow run with its earlier attempts", () => {
    expect(
      reduceRun(
        {
          id: 41157211653,
          event: "pull_request",
          head_branch: "M1.05",
          status: "completed",
          conclusion: "success",
          run_attempt: 2,
          created_at: "2026-10-31T01:50:07Z",
          actor: user,
          head_commit: { author: { email: "redacted@example.invalid" } },
        },
        [{ run_attempt: 1, conclusion: "failure" }],
      ),
    ).toEqual({
      id: 41157211653,
      event: "pull_request",
      headBranch: "M1.05",
      status: "completed",
      conclusion: "success",
      runAttempt: 2,
      createdAt: "2026-10-31T01:50:07Z",
      earlierAttempts: ["failure"],
    });
  });

  it("reduces board items to fields keyed by issue number", () => {
    const item = (number: number | null, fields: [string, string][]) => ({
      content:
        number === null
          ? { title: "Draft" }
          : { number, repository: { nameWithOwner: "o/taskville" } },
      fieldValues: {
        nodes: [...fields.map(([field, name]) => ({ name, field: { name: field } })), {}],
      },
    });
    expect(
      reduceBoard(
        [
          item(5, [
            ["Size", "M"],
            ["Lane", "Domain"],
            ["Priority", "P0"],
            ["Phase", "M1 Headless foundation"],
            ["Status", "Done"],
          ]),
          item(94, [["Size", "M"]]),
          item(null, [["Size", "S"]]),
        ],
        "o/taskville",
      ),
    ).toEqual({
      "5": { size: "M", lane: "Domain", priority: "P0", phase: "M1 Headless foundation" },
      "94": { size: "M" },
    });
  });

  it("ignores board items from another repository", () => {
    const other = {
      content: { number: 5, repository: { nameWithOwner: "o/other" } },
      fieldValues: { nodes: [{ name: "S", field: { name: "Size" } }] },
    };
    expect(reduceBoard([other], "o/taskville")).toEqual({});
  });
});

describe("redactSnapshot", () => {
  it("replaces given words in every string, case-insensitively, without touching the input", () => {
    const snapshot = {
      ...example,
      taskReports: { "M9.01": "See https://github.com/Owner-Login/repo/issues/1 by owner-login." },
    };
    const redacted = redactSnapshot(snapshot, ["owner-login"]);
    expect(redacted.taskReports["M9.01"]).toBe(
      "See https://github.com/redacted/repo/issues/1 by redacted.",
    );
    expect(snapshot.taskReports["M9.01"]).toContain("owner-login");
    expect(redacted.issues).toEqual(example.issues);
  });

  it("ignores empty words", () => {
    expect(redactSnapshot(example, [""])).toEqual(example);
  });
});
