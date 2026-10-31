import { describe, expect, it } from "vitest";
import { mermaidBlocks, validateMermaid } from "../src/mermaid.ts";

const gantt = `gantt
  title M1: first commit to merge
  dateFormat YYYY-MM-DDTHH:mm
  axisFormat %b %d
  section Domain
  M1.05 Protocol v1 :done, 2026-10-31T01:38, 2026-10-31T01:56
  M1.07 Domain reducer :active, 2026-10-31T02:00, 2026-10-31T02:30`;

const xychart = `xychart-beta
  title "Open tickets per day"
  x-axis ["10-31", "11-01"]
  y-axis "Open tickets" 0 --> 23
  line [20, 13]
  line [23, 0]`;

const pie = `pie title Reviews
  "Passed first review" : 3
  "One fix round" : 5
  "Escalated" : 0`;

describe("validateMermaid", () => {
  it.each([
    ["gantt", gantt],
    ["xychart", xychart],
    ["pie", pie],
  ])("accepts a valid %s chart", (_name, chart) => {
    expect(validateMermaid(chart)).toEqual([]);
  });

  it.each([
    ["unknown diagram", "flowchart LR\n  a --> b", /diagram type/],
    ["gantt task with a colon in its name", gantt.replace("Protocol v1", "Protocol: v1"), /task/],
    [
      "gantt date in the wrong format",
      gantt.replace("2026-10-31T01:38", "2026-10-31 01:38"),
      /date/,
    ],
    ["gantt end before start", gantt.replace("2026-10-31T01:56", "2026-10-31T01:00"), /before/],
    [
      "gantt task before any section",
      "gantt\n  dateFormat YYYY-MM-DDTHH:mm\n  T :done, 2026-10-31T01:00, 2026-10-31T02:00",
      /section/,
    ],
    ["xychart series length mismatch", xychart.replace("[20, 13]", "[20]"), /2 x-axis/],
    ["xychart non-numeric value", xychart.replace("[20, 13]", "[20, not measured]"), /number/],
    [
      "xychart unquoted label with a space",
      xychart.replace('["10-31", "11-01"]', "[Oct 31, Nov 01]"),
      /label/,
    ],
    ["xychart y-axis max not above min", xychart.replace("0 --> 23", "0 --> 0"), /y-axis/],
    ["xychart bar above the y-axis max", xychart.replace("line [20, 13]", "bar [20, 24]"), /above/],
    ["pie negative slice", pie.replace(": 3", ": -1"), /slice/],
    ["pie malformed slice", pie.replace('"Escalated" : 0', "Escalated 0"), /slice/],
    ["leftover template tag", xychart.replace("23", "{{peak}}"), /template/],
  ])("rejects %s", (_name, chart, message) => {
    const errors = validateMermaid(chart);
    expect(errors.length).toBeGreaterThan(0);
    expect(errors.join("\n")).toMatch(message);
  });
});

describe("mermaidBlocks", () => {
  it("extracts every mermaid fence with the line of its opening fence", () => {
    const md = `# R\n\n\`\`\`mermaid\n${pie}\n\`\`\`\n\ntext\n\n\`\`\`mermaid\n${xychart}\n\`\`\`\n\`\`\`ts\nx\n\`\`\`\n`;
    const blocks = mermaidBlocks(md);
    expect(blocks.map((b) => b.line)).toEqual([3, 12]);
    expect(blocks[0]?.source).toBe(pie);
  });
});
