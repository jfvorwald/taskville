import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { LiveTab } from "../live/LiveTab.tsx";
import { AGENT, articles, build, paint, seedStore } from "../live/liveKit.tsx";
import { fakeBackend } from "./codeKit.tsx";
import { buildEditorLink } from "./editorLink.ts";
import { createCodeHighlighter } from "./highlighter.ts";

// M5.09 red round 3, item 3: Live-tab Edit and Write bodies render through ExpandableCode. Seam:
// LiveTab takes optional `highlighter?: CodeHighlighter` (default: the shared Shiki one) and
// `editorTemplate?: string`. Each such card has an Expand control; the highlighter loads on the
// first expand across cards, never before; the expanded body is highlighted text; and the editor
// link is exactly buildEditorLink(path, template).

const EDIT_PATH = "/r/my src/edit #1.ts";
const SPECS = [
  {
    id: "e1",
    tool: "Edit",
    input: {
      file_path: EDIT_PATH,
      old_string: "const before = 1;",
      new_string: "const after = 2;",
    },
    filePaths: [EDIT_PATH],
  },
  {
    id: "w1",
    tool: "Write",
    input: { file_path: "/r/docs/x.md", content: "# written heading\nbody line" },
    filePaths: ["/r/docs/x.md"],
  },
];

async function show() {
  const fake = fakeBackend();
  const load = vi.fn(async () => fake.backend);
  const highlighter = createCodeHighlighter(load);
  const { calls, evidence } = build(SPECS);
  await render(
    <div data-testid="agent-panel-tab-slot">
      <LiveTab
        agentId={AGENT}
        store={seedStore()}
        select={vi.fn()}
        calls={calls}
        evidence={evidence}
        highlighter={highlighter}
      />
    </div>,
  );
  await paint();
  await expect.poll(() => articles().elements().length).toBe(2);
  return { load, calls: fake.calls };
}

describe("Live tab code bodies go through ExpandableCode", () => {
  it("offers an Expand control on Edit and Write cards and loads the highlighter on first expand only", async () => {
    const { load, calls } = await show();
    const edit = articles().filter({ hasText: "Edit" });
    const write = articles().filter({ hasText: "Write" });
    const expandEdit = edit.getByRole("button", { name: /^expand/i });
    const expandWrite = write.getByRole("button", { name: /^expand/i });
    await expect.element(expandEdit).toBeVisible();
    await expect.element(expandWrite).toBeVisible();
    expect(load).not.toHaveBeenCalled();
    await expandEdit.click();
    await expect
      .poll(() => edit.element().querySelector("pre")?.textContent ?? "")
      .toContain("const after = 2;");
    expect(load).toHaveBeenCalledTimes(1);
    expect(calls.some((c) => c.text.includes("const after = 2;"))).toBe(true);
    await expandWrite.click();
    await expect
      .poll(() => write.element().querySelector("pre")?.textContent ?? "")
      .toContain("body line");
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("links an expanded Edit to the editor with the encoded path", async () => {
    await show();
    const edit = articles().filter({ hasText: "Edit" });
    await edit.getByRole("button", { name: /^expand/i }).click();
    const href = buildEditorLink(EDIT_PATH);
    expect(href).toBe("vscode://file/r/my%20src/edit%20%231.ts");
    await expect
      .element(page.getByRole("link", { name: /open in editor/i }))
      .toHaveAttribute("href", href as string);
  });
});
