import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { fakeBackend, lazyHighlighterParts } from "./codeKit.tsx";
import { ExpandableCode } from "./ExpandableCode.tsx";
import { createCodeHighlighter } from "./highlighter.ts";

// M5.09 red: lazy load on first expand, privacy, and the editor link on an expanded card.

function setup() {
  const fake = fakeBackend();
  const { load } = lazyHighlighterParts(fake.backend);
  return { ...fake, load, highlighter: createCodeHighlighter(load) };
}

describe("ExpandableCode", () => {
  it("loads the highlighter only on the first expand, once across cards", async () => {
    const { highlighter, load } = setup();
    const screen = await render(
      <>
        <ExpandableCode
          label="Edit a"
          text="let a = 1;"
          language="ts"
          privacy={false}
          highlighter={highlighter}
        />
        <ExpandableCode
          label="Edit b"
          text="let b = 2;"
          language="ts"
          privacy={false}
          highlighter={highlighter}
        />
      </>,
    );
    expect(load).not.toHaveBeenCalled();
    expect(document.querySelector("pre")).toBeNull();
    await screen.getByRole("button", { name: /expand.*edit a/i }).click();
    await expect.poll(() => document.querySelector("pre")?.textContent).toContain("let a = 1;");
    expect(load).toHaveBeenCalledTimes(1);
    await screen.getByRole("button", { name: /expand.*edit b/i }).click();
    await expect.poll(() => document.querySelectorAll("pre").length).toBe(2);
    expect(load).toHaveBeenCalledTimes(1);
  });

  it("does not load or show anything in privacy mode, and says why", async () => {
    const { highlighter, load } = setup();
    const screen = await render(
      <ExpandableCode
        label="Edit a"
        text="let hidden = 1;"
        language="ts"
        privacy
        highlighter={highlighter}
      />,
    );
    await screen.getByRole("button", { name: /expand/i }).click();
    await expect.element(screen.getByText("Code hidden by the privacy setting")).toBeVisible();
    expect(document.body.textContent).not.toContain("let hidden");
    expect(load).not.toHaveBeenCalled();
  });

  it("offers an Open in editor link built from the template, with the path encoded", async () => {
    const { highlighter } = setup();
    const screen = await render(
      <ExpandableCode
        label="Edit a"
        text="x"
        language="ts"
        privacy={false}
        highlighter={highlighter}
        path="/Users/me/my proj/a#1.ts"
      />,
    );
    await screen.getByRole("button", { name: /expand/i }).click();
    const link = page.getByRole("link", { name: /open in editor/i });
    await expect.element(link).toHaveAttribute("href", "vscode://file/Users/me/my%20proj/a%231.ts");
    await expect.element(link).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("shows no link when the template is unsafe or the path has a dot-dot segment", async () => {
    const { highlighter } = setup();
    await render(
      <>
        <ExpandableCode
          label="Bad template"
          text="x"
          language="ts"
          privacy={false}
          highlighter={highlighter}
          path="/a/b.ts"
          editorTemplate="javascript:alert(1)//{path}"
          defaultExpanded
        />
        <ExpandableCode
          label="Bad path"
          text="y"
          language="ts"
          privacy={false}
          highlighter={highlighter}
          path="/a/../../etc/passwd"
          defaultExpanded
        />
      </>,
    );
    await expect.poll(() => document.querySelectorAll("pre").length).toBe(2);
    expect(document.querySelector("a")).toBeNull();
  });
});
