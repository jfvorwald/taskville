import { describe, expect, it } from "vitest";
import { classifyReview, listsNotRun } from "../src/review.ts";

const report = (roborev: string, notRun = "full suite and e2e (task tier only).") =>
  `# M1.99: Example (#1)\n\n- **Result:** done\n- **PR:** #1 · **roborev:** ${roborev}\n- **Checks run:** x\n- **NOT RUN:** ${notRun}\n`;

// Phrasings copied from the M1 task reports.
describe("classifyReview", () => {
  it.each([
    "pass (job 4668, pre_merge panel, no findings; post-commit jobs 4664, 4665, 4669 pass)",
    "pass (job 4797, pre_merge panel, no findings); post-commit jobs 4788, 4794 pass",
  ])("passed first review: %s", (line) => {
    expect(classifyReview(report(line))).toBe("first_pass");
  });

  it.each([
    "panel job 4675 (2 high) fixed in 3b65b1d; re-review job 4684 (1 medium) fixed in 9c9927d and 83439be; post-commit jobs 4681, 4695, 4696 pass. No third panel round (re-review once rule)",
    "pre_merge panel job 4680 failed (1 high, 2 medium), fixed in 0ddc37b; re-review job 4694 failed with new findings (2 high, 1 medium), fixed or answered with evidence in 36d0d39",
  ])(
    "more than one fix round when the first review and the re-review both had findings: %s",
    (line) => {
      expect(classifyReview(report(line))).toBe("multiple_fix");
    },
  );

  it.each([
    "pass (job 4728, pre_merge panel) after one high finding in job 4720 was fixed in 8b0483d (an unlabelled heuristic subagent parent link).",
    "pre_merge panel job 4744 pass (no findings). Re-review panel job 4762 after rebasing onto M1.10: 1 medium (health schema) and 1 low (pairing code), both fixed in 8b869a4",
    "a critical finding fixed in abc1234",
  ])("one fix round when a medium-or-higher finding was fixed: %s", (line) => {
    expect(classifyReview(report(line))).toBe("one_fix");
  });

  it.each([
    "same finding survived two fixes; escalated to the debugger",
    "findings fixed in abc; decision ticket #140 opened for the remaining one",
  ])("escalated: %s", (line) => {
    expect(classifyReview(report(line))).toBe("escalated");
  });

  it.each([
    // Findings were fixed but the report gives no severity, so the outcome cannot be told.
    "pass (job 4733, pre_merge panel); findings fixed in d292fe9 (jobs 4701, 4704: token write, FIFO)",
    "pass (job 4781, pre_merge panel); finding from job 4776 (symlinked home) fixed in bc91f18",
    "in progress",
  ])("not measured when the report is ambiguous: %s", (line) => {
    expect(classifyReview(report(line))).toBeNull();
  });

  it("does not read 'no findings at or above medium' as a medium finding", () => {
    expect(classifyReview(report("pass (job 1, no findings at or above medium)"))).toBe(
      "first_pass",
    );
  });

  it("is not measured without a task report or a roborev field", () => {
    expect(classifyReview(undefined)).toBeNull();
    expect(classifyReview("# M1.99\n\n- **Result:** done\n")).toBeNull();
  });

  it("prefers an explicit Review outcome field", () => {
    const text = `${report("pass (job 1)")}- **Review outcome:** one fix round\n`;
    expect(classifyReview(text)).toBe("one_fix");
    expect(classifyReview(`${report("x")}- **Review outcome:** escalated\n`)).toBe("escalated");
    expect(classifyReview(`${report("x")}- **Review outcome:** passed first review\n`)).toBe(
      "first_pass",
    );
  });
});

describe("listsNotRun", () => {
  it("is true when the NOT RUN field lists something", () => {
    expect(listsNotRun(report("pass"))).toBe(true);
  });

  it.each(["none", "None.", "none (all checks ran)"])("is false for %j", (notRun) => {
    expect(listsNotRun(report("pass", notRun))).toBe(false);
  });

  it("reads a NOT RUN field continued on indented lines", () => {
    const text =
      "- **NOT RUN:**\n  - The browser run (no browser in CI).\n- **Measurements:** none\n";
    expect(listsNotRun(text)).toBe(true);
  });

  it("is not measured without a report or field", () => {
    expect(listsNotRun(undefined)).toBeNull();
    expect(listsNotRun("# M1.99\n")).toBeNull();
  });
});
