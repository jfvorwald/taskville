import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { renderRetro } from "../src/render.ts";
import type { Snapshot } from "../src/types.ts";
import { example, NOW } from "./example-snapshot.ts";

// M5.29 (#369): the milestone retro shows tokens and cost per agent.
//
// Seam pinned here: `Snapshot.agentCost?: AgentCostRecord[]` (scripts/retro/src/types.ts), one
// record per agent from the engine's persisted OTLP rows, a pure input like the rest of the
// snapshot:
//
//   { agentId: string, tokens: { input, output, cacheRead, cacheCreation }, costUsd: number }
//
// The report gets a section headed `## Tokens and cost` (in docs/retros/TEMPLATE.md, placed before
// the written sections) with one table row per agent, sorted by cost descending then agent ID:
//
//   | <agentId> | <input> | <output> | <cache read> | <cache creation> | $<cost, 2 decimals> |
//
// plus a `| Total | ... |` row summing every column. Token counts are plain integers (no
// thousands separators). With no `agentCost` (or an empty list) the section says "not measured",
// never an estimate or a zero.

const template = readFileSync(
  join(import.meta.dirname, "..", "..", "..", "docs", "retros", "TEMPLATE.md"),
  "utf8",
);

const SESSION = "1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const withCost = (agentCost?: Snapshot["agentCost"]): Snapshot => ({
  ...example,
  ...(agentCost === undefined ? {} : { agentCost }),
});

const FIXTURE_COST = [
  {
    agentId: `claude-code:${SESSION}:a0b4668e13e056653`,
    tokens: { input: 500, output: 100, cacheRead: 2500, cacheCreation: 150 },
    costUsd: 0.12,
  },
  {
    agentId: `claude-code:${SESSION}`,
    tokens: { input: 1000, output: 200, cacheRead: 5000, cacheCreation: 300 },
    costUsd: 0.4,
  },
  {
    agentId: `claude-code:${SESSION}:afdf84bea07a9064c`,
    tokens: { input: 400, output: 90, cacheRead: 2000, cacheCreation: 100 },
    costUsd: 0.12,
  },
];

const section = (md: string): string => {
  const start = md.indexOf("## Tokens and cost");
  if (start < 0) return "";
  const next = md.indexOf("\n## ", start + 1);
  return md.slice(start, next < 0 ? undefined : next);
};

describe("retro tokens and cost per agent", () => {
  const md = renderRetro({
    snapshot: withCost(FIXTURE_COST),
    template,
    now: NOW,
    key: "M9",
  });

  it("has a Tokens and cost section before the written sections", () => {
    expect(md).toContain("## Tokens and cost");
    expect(md.indexOf("## Tokens and cost")).toBeLessThan(md.indexOf("## What went well"));
  });

  it("shows one row per agent with its four token counts and cost", () => {
    const text = section(md);
    expect(text).toContain(`| \`claude-code:${SESSION}\` | 1000 | 200 | 5000 | 300 | $0.40 |`);
    expect(text).toContain(
      `| \`claude-code:${SESSION}:afdf84bea07a9064c\` | 400 | 90 | 2000 | 100 | $0.12 |`,
    );
    expect(text).toContain(
      `| \`claude-code:${SESSION}:a0b4668e13e056653\` | 500 | 100 | 2500 | 150 | $0.12 |`,
    );
  });

  it("sorts by cost descending, then agent ID", () => {
    const text = section(md);
    const at = (id: string) => text.indexOf(`| \`${id}\` |`);
    const lead = at(`claude-code:${SESSION}`);
    const b = at(`claude-code:${SESSION}:a0b4668e13e056653`);
    const a = at(`claude-code:${SESSION}:afdf84bea07a9064c`);
    expect(lead).toBeGreaterThan(-1);
    expect(lead).toBeLessThan(b);
    expect(b).toBeLessThan(a);
  });

  it("says the totals are engine-lifetime and machine-wide, not this milestone alone", () => {
    expect(section(md)).toContain(
      "Engine lifetime totals for every project in this Taskville home, not only this milestone.",
    );
  });

  it("totals every column", () => {
    expect(section(md)).toContain("| Total | 1900 | 390 | 9500 | 550 | $0.64 |");
  });

  it("keeps the rest of the report intact and valid", () => {
    expect(md).not.toMatch(/\{\{|\}\}|undefined|NaN|null/);
    expect(md).toContain("## Quality signals");
  });

  it("escapes pipes, newlines and control characters in an agent ID, inside backticks", () => {
    const hostile = "claude-code:x|y\nz\r\u0000\u001b[31m\u2028| 9 | 9 | 9 | 9 | $9.00 |";
    const out = renderRetro({
      snapshot: withCost([
        {
          agentId: hostile,
          tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
          costUsd: 1,
        },
      ]),
      template,
      now: NOW,
      key: "M9",
    });
    const text = section(out);
    const bad = [...text].filter((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return (
        (code < 0x20 && code !== 0x0a) ||
        code === 0x7f ||
        code === 0x85 ||
        code === 0x2028 ||
        code === 0x2029
      );
    });
    expect(bad).toEqual([]);
    const rows = text.split("\n").filter((line) => line.startsWith("|"));
    // header, separator, one agent, Total: the hostile ID added no row and no column.
    expect(rows).toHaveLength(4);
    for (const row of rows) expect(row.split(/(?<!\\)\|/)).toHaveLength(8);
    const agentRow = rows[2] ?? "";
    expect(agentRow).toMatch(/^\| `claude-code:x\\\|y/);
    expect(agentRow).toMatch(/ \| 1 \| 2 \| 3 \| 4 \| \$1\.00 \|$/);
  });

  it("renders an agent ID with backticks as a literal code span", () => {
    const longestRun = (text: string) =>
      Math.max(0, ...(text.match(/`+/g) ?? []).map((r) => r.length));
    for (const hostile of ["claude-code:a`b``c", "`claude-code:edge`", "claude-code:x```y`z"]) {
      const out = renderRetro({
        snapshot: withCost([
          {
            agentId: hostile,
            tokens: { input: 1, output: 2, cacheRead: 3, cacheCreation: 4 },
            costUsd: 1,
          },
        ]),
        template,
        now: NOW,
        key: "M9",
      });
      const rows = section(out)
        .split("\n")
        .filter((line) => line.startsWith("|"));
      expect(rows).toHaveLength(4);
      for (const row of rows) expect(row.split(/(?<!\\)\|/)).toHaveLength(8);
      const agentRow = rows[2] ?? "";
      const cell = (agentRow.split(/(?<!\\)\|/)[1] ?? "").trim();
      // A code span: the opening run, the ID (one padding space each side allowed), the same run.
      const match = /^(`+)(.*?)\1$/.exec(cell);
      expect(match, `cell ${cell}`).not.toBeNull();
      const delimiter = (match?.[1] ?? "").length;
      let inner = match?.[2] ?? "";
      if (inner.startsWith(" ") && inner.endsWith(" ")) inner = inner.slice(1, -1);
      expect(inner).toBe(hostile);
      expect(delimiter).toBeGreaterThan(longestRun(hostile));
      expect(agentRow).toMatch(/ \| 1 \| 2 \| 3 \| 4 \| \$1\.00 \|$/);
    }
  });

  it("says not measured, not zero, when the snapshot has no cost data", () => {
    for (const snapshot of [withCost(), withCost([])]) {
      const out = renderRetro({ snapshot, template, now: NOW, key: "M9" });
      const text = section(out);
      expect(text).toContain("not measured");
      expect(text).not.toContain("$0.00");
      expect(text).not.toContain("| Total |");
    }
  });
});
