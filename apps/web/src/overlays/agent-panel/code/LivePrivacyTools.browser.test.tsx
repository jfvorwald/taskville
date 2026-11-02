import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { LiveTab } from "../live/LiveTab.tsx";
import { AGENT, articles, build, type CallSpec, paint, seedStore, slot } from "../live/liveKit.tsx";

// M5.09 red round 3, item 1: under Hide code no tool that carries code or file content shows a
// body in the Live tab, including the ones the generic renderer prints (MultiEdit, NotebookEdit).
// File names stay visible. Each body holds a sentinel that must not reach the DOM.

const TOOLS: { tool: string; file: string; sentinel: string; input: unknown }[] = [
  {
    tool: "Edit",
    file: "/r/src/edit.ts",
    sentinel: "SENTINEL_EDIT",
    input: {
      file_path: "/r/src/edit.ts",
      old_string: "SENTINEL_EDIT_OLD",
      new_string: "SENTINEL_EDIT_NEW",
    },
  },
  {
    tool: "MultiEdit",
    file: "/r/src/multi.ts",
    sentinel: "SENTINEL_MULTI",
    input: {
      file_path: "/r/src/multi.ts",
      edits: [
        { old_string: "SENTINEL_MULTI_OLD", new_string: "SENTINEL_MULTI_NEW" },
        { old_string: "SENTINEL_MULTI_OLD2", new_string: "SENTINEL_MULTI_NEW2" },
      ],
    },
  },
  {
    tool: "Write",
    file: "/r/docs/write.md",
    sentinel: "SENTINEL_WRITE",
    input: { file_path: "/r/docs/write.md", content: "SENTINEL_WRITE body" },
  },
  {
    tool: "NotebookEdit",
    file: "/r/nb/note.ipynb",
    sentinel: "SENTINEL_NOTEBOOK",
    input: {
      notebook_path: "/r/nb/note.ipynb",
      cell_id: "c1",
      new_source: "SENTINEL_NOTEBOOK = 1",
      edit_mode: "replace",
    },
  },
];

async function show(privacy: boolean) {
  const specs: CallSpec[] = TOOLS.map((t, i) => ({
    id: `p${i}`,
    tool: t.tool,
    input: t.input,
    filePaths: [t.file],
  }));
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
  await expect.poll(() => articles().elements().length).toBe(TOOLS.length);
}

describe("Live tab privacy for every content-carrying tool", () => {
  it.each(TOOLS)("$tool shows its body when privacy is off", async ({ sentinel }) => {
    await show(false);
    expect(slot().element().textContent).toContain(sentinel);
  });

  it.each(TOOLS)(
    "$tool shows no body under privacy and keeps the file name",
    async ({ tool, file, sentinel }) => {
      await show(true);
      const card = articles()
        .elements()
        .find((el) => el.textContent?.includes(tool));
      expect(card).toBeDefined();
      const text = card?.textContent ?? "";
      expect(text).not.toContain(sentinel);
      expect(text).toContain(file.split("/").pop() as string);
    },
  );

  it("leaks nothing anywhere in the tab, expanded controls included", async () => {
    await show(true);
    expect(slot().element().textContent).not.toMatch(/SENTINEL_/);
    expect(slot().element().innerHTML).not.toMatch(/SENTINEL_/);
  });
});
