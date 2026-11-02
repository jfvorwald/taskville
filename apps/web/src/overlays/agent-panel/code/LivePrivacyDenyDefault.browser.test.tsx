import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { LiveTab } from "../live/LiveTab.tsx";
import { AGENT, articles, build, type CallSpec, paint, seedStore, slot } from "../live/liveKit.tsx";

// M5.09 red round 4, item 1: privacy is deny-by-default. Under Hide code the Live tab renders only
// each card's heading (tool name, status, paths, counts) and the "Code hidden by the privacy
// setting" note, for EVERY tool: no input JSON, no Bash command or output, no Search output, no
// Agent prompt, and nothing for tool names the renderer has never heard of. Sentinels must not
// appear in text, innerHTML (so also title and aria-label) anywhere in the tab.

const NOTE = "Code hidden by the privacy setting";

interface Case {
  name: string;
  spec: CallSpec;
  /** Visible file name that must stay. */
  keep?: string;
}

const CASES: Case[] = [
  {
    name: "Bash with a heredoc, stdout and stderr",
    spec: {
      id: "c-bash",
      tool: "Bash",
      input: { command: "cat <<EOF\nSENTINEL_BASH_CMD\nEOF", description: "SENTINEL_BASH_DESC" },
      output: { stdout: "SENTINEL_BASH_OUT", stderr: "SENTINEL_BASH_ERR", interrupted: false },
      durationMs: 5,
    },
  },
  {
    name: "Grep in content mode",
    spec: {
      id: "c-grep",
      tool: "Grep",
      outputRaw: "g.ts:3: SENTINEL_GREP_HIT",
      filePaths: ["/r/src/g.ts"],
    },
    keep: "g.ts",
  },
  {
    name: "Glob",
    spec: {
      id: "c-glob",
      tool: "Glob",
      input: { pattern: "SENTINEL_GLOB_PAT/**/*.ts" },
      outputRaw: "SENTINEL_GLOB_HIT",
    },
  },
  {
    name: "Agent prompt",
    spec: {
      id: "c-agent",
      tool: "Agent",
      input: {
        description: "SENTINEL_AGENT_DESC",
        prompt: "SENTINEL_AGENT_PROMPT",
        subagent_type: "reviewer",
      },
      outputRaw: "SENTINEL_AGENT_OUT",
    },
  },
  {
    name: "SendMessage",
    spec: {
      id: "c-msg",
      tool: "SendMessage",
      input: { to: "someone", message: "SENTINEL_MSG_BODY" },
    },
  },
  {
    name: "apply_patch (unknown tool)",
    spec: {
      id: "c-patch",
      tool: "apply_patch",
      input: { input: "*** Begin Patch\n*** Update File: /r/src/p.ts\n+SENTINEL_PATCH_BODY" },
      filePaths: ["/r/src/p.ts"],
    },
    keep: "p.ts",
  },
  {
    name: "mcp__x__write_file (unknown tool)",
    spec: {
      id: "c-mcp",
      tool: "mcp__x__write_file",
      input: { path: "/r/src/m.ts", content: "SENTINEL_MCP_BODY" },
      outputRaw: "SENTINEL_MCP_OUT",
      filePaths: ["/r/src/m.ts"],
    },
    keep: "m.ts",
  },
  {
    name: "lower-case edit",
    spec: {
      id: "c-edit",
      tool: "edit",
      input: {
        file_path: "/r/src/l.ts",
        old_string: "SENTINEL_LOWER_OLD",
        new_string: "SENTINEL_LOWER_NEW",
      },
      filePaths: ["/r/src/l.ts"],
    },
    keep: "l.ts",
  },
];

async function show(privacy: boolean, specs: CallSpec[]) {
  const { calls, evidence } = build(specs);
  await render(
    <div data-testid="agent-panel-tab-slot">
      <LiveTab
        agentId={AGENT}
        store={seedStore()}
        select={vi.fn()}
        calls={calls}
        evidence={evidence}
        privacy={privacy}
      />
    </div>,
  );
  await paint();
  await expect.poll(() => articles().elements().length).toBeGreaterThan(0);
}

describe("Live tab privacy is deny-by-default", () => {
  it("shows every sentinel when privacy is off (the sentinels are real)", async () => {
    await show(
      false,
      CASES.map((c) => c.spec),
    );
    const text = slot().element().textContent ?? "";
    for (const sentinel of [
      "SENTINEL_BASH_CMD",
      "SENTINEL_AGENT_PROMPT",
      "SENTINEL_PATCH_BODY",
      "SENTINEL_MCP_BODY",
    ])
      expect(text).toContain(sentinel);
  });

  it.each(CASES)(
    "$name: no content, only the heading and the hidden note",
    async ({ spec, keep }) => {
      await show(true, [spec]);
      const card = articles().element();
      expect(card.textContent).not.toMatch(/SENTINEL_/);
      expect(card.innerHTML).not.toMatch(/SENTINEL_/);
      expect(card.textContent).toContain(NOTE);
      expect(card.textContent).toContain(String(spec.tool));
      if (keep) expect(card.textContent).toContain(keep);
    },
  );

  it("leaks nothing when all of them are in one feed", async () => {
    await show(
      true,
      CASES.map((c) => c.spec),
    );
    expect(slot().element().innerHTML).not.toMatch(/SENTINEL_/);
    expect(slot().element().textContent).not.toMatch(/SENTINEL_/);
    for (const el of slot().element().querySelectorAll("[title], [aria-label]")) {
      expect(`${el.getAttribute("title")} ${el.getAttribute("aria-label")}`).not.toMatch(
        /SENTINEL_/,
      );
    }
  });
});
