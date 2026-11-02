import { describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { LiveTab } from "../live/LiveTab.tsx";
import { AGENT, articles, build, paint, seedStore } from "../live/liveKit.tsx";
import { fakeBackend } from "./codeKit.tsx";
import { createCodeHighlighter } from "./highlighter.ts";

// M5.09 red round 4, item 5: the expanded card's "Open in editor" link follows the same rule as
// the `Path` link: none when the path is redactable or holds a control or bidi character.

const RLO = String.fromCodePoint(0x202e);
const BEL = String.fromCodePoint(0x07);
const ZWSP = String.fromCodePoint(0x200b);
const TOKEN = `ghp_${"a1B2c3D4e5".repeat(4)}`;

async function expanded(path: string) {
  const fake = fakeBackend();
  const { calls, evidence } = build([
    {
      id: "l1",
      tool: "Edit",
      input: { file_path: path, old_string: "before", new_string: "after_marker" },
      filePaths: [path],
    },
  ]);
  await render(
    <div data-testid="agent-panel-tab-slot">
      <LiveTab
        agentId={AGENT}
        store={seedStore()}
        select={vi.fn()}
        calls={calls}
        evidence={evidence}
        highlighter={createCodeHighlighter(async () => fake.backend)}
      />
    </div>,
  );
  await paint();
  await articles()
    .getByRole("button", { name: /^expand/i })
    .click();
  await expect
    .poll(() => articles().element().querySelector("pre")?.textContent ?? "")
    .toContain("after_marker");
}

describe("Open in editor link on an expanded Live card", () => {
  it("is present for an ordinary path (control)", async () => {
    await expanded("/r/src/plain.ts");
    await expect.element(page.getByRole("link", { name: /open in editor/i })).toBeVisible();
  });

  it.each([
    ["a bidi override", `/r/src/${RLO}gnp.ts`],
    ["a control character", `/r/src/a${BEL}b.ts`],
    ["a zero-width space", `/r/src/a${ZWSP}b.ts`],
    ["a secret-looking segment", `/r/${TOKEN}/x.ts`],
  ])("is absent for a path with %s", async (_name, path) => {
    await expanded(path);
    expect(page.getByRole("link", { name: /open in editor/i }).elements()).toHaveLength(0);
    expect(articles().element().querySelector("a[href^='vscode:']")).toBeNull();
  });
});
