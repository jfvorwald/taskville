// Review outcome and NOT RUN, read from a ticket's task report (docs/tasks/<KEY>.md).
//
// roborev results are recorded as text in the report's `**roborev:**` field, not as GitHub
// reviews. The rules below classify only what the text states plainly and return null ("not
// measured") otherwise:
// - an explicit `**Review outcome:**` field wins;
// - escalation words (escalated, debugger, decision ticket) mean escalated;
// - a counted, fixed medium, high, or critical finding ("1 medium ... fixed") means one fix round,
//   or more than one when both the first review and the re-review report such findings; a
//   finding with no recorded fix is not measured;
// - "pass" with nothing "fixed" means passed first review;
// - anything else (for example findings fixed with no severity given) is not measured.

export type ReviewOutcome = "first_pass" | "one_fix" | "multiple_fix" | "escalated";

const field = (text: string, name: string): string | null => {
  const match = new RegExp(`\\*\\*${name}:\\*\\*([^\\n]*)`, "i").exec(text);
  return match === null ? null : (match[1] ?? "").trim();
};

// A positive count: "0 high" is not a finding.
const SEVERE_FINDING = /\b([1-9]\d*|one|two|three|four|five|a|an)\s+(critical|high|medium)\b/i;

export function classifyReview(report: string | undefined): ReviewOutcome | null {
  if (report === undefined) return null;
  const explicit = field(report, "Review outcome")?.toLowerCase();
  if (explicit !== undefined) {
    if (explicit.startsWith("passed first")) return "first_pass";
    if (explicit.startsWith("one fix")) return "one_fix";
    if (explicit.startsWith("more than one fix")) return "multiple_fix";
    if (explicit.startsWith("escalated")) return "escalated";
  }
  const roborev = field(report, "roborev");
  if (roborev === null) return null;
  if (/escalat|debugger|decision ticket|needs:decision/i.test(roborev)) return "escalated";
  // Split at the re-review; each part is one review round. A round counts as a fix round only
  // when it reports a counted finding and records a fix in that same part.
  const reReview = roborev.search(/re-?review/i);
  const rounds =
    reReview === -1 ? [roborev] : [roborev.slice(0, reReview), roborev.slice(reReview)];
  const fixed = /\bfixed\b/i.test(roborev);
  if (SEVERE_FINDING.test(roborev)) {
    const fixRounds = rounds.filter((r) => SEVERE_FINDING.test(r) && /\bfixed\b/i.test(r)).length;
    if (fixRounds === 0) return null;
    return fixRounds > 1 ? "multiple_fix" : "one_fix";
  }
  if (/\bpass\b/i.test(roborev) && !fixed) return "first_pass";
  return null;
}

/**
 * Whether the report's `**NOT RUN:**` field lists anything (true) or says "none" (false); null
 * when there is no report or no such field. The field may continue on indented lines.
 */
export function listsNotRun(report: string | undefined): boolean | null {
  if (report === undefined) return null;
  const lines = report.split(/\r?\n/);
  const index = lines.findIndex((line) => /^\s*-\s*\*\*NOT RUN:\*\*/i.test(line));
  if (index === -1) return null;
  const first = (lines[index] ?? "").replace(/^\s*-\s*\*\*NOT RUN:\*\*/i, "").trim();
  const continuation: string[] = [];
  for (const line of lines.slice(index + 1)) {
    if (!/^\s+\S/.test(line)) break;
    continuation.push(line.trim());
  }
  const content = [first, ...continuation].join(" ").trim();
  if (content === "") return null;
  return !/^none\b/i.test(content);
}
