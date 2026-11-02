import { describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";
import { CodeBody } from "./CodeBody.tsx";
import { fakeBackend, lazyHighlighterParts, RLO, ZWSP } from "./codeKit.tsx";
import { createCodeHighlighter } from "./highlighter.ts";

// M5.09 red: privacy mode, inert text, masked secrets (ARCHITECTURE 2.10 and 13).

const GHP = `ghp_${"a1B2c3D4e5".repeat(4)}`;

function setup(tokenize?: Parameters<typeof fakeBackend>[0]) {
  const fake = fakeBackend(tokenize);
  const { load } = lazyHighlighterParts(fake.backend);
  return { ...fake, load, highlighter: createCodeHighlighter(load) };
}

describe("privacy mode", () => {
  it("hides the code body entirely and never loads or runs the highlighter", async () => {
    const { highlighter, load, calls } = setup();
    const screen = await render(
      <CodeBody text={"const secretPlan = 42;"} language="ts" privacy highlighter={highlighter} />,
    );
    await expect.element(screen.getByText("Code hidden by the privacy setting")).toBeVisible();
    expect(document.body.textContent).not.toContain("secretPlan");
    expect(document.querySelector("pre, code")).toBeNull();
    expect(load).not.toHaveBeenCalled();
    expect(calls).toHaveLength(0);
  });

  it("shows the body when privacy is off", async () => {
    const { highlighter } = setup();
    await render(
      <CodeBody
        text={"const shown = 1;"}
        language="ts"
        privacy={false}
        highlighter={highlighter}
      />,
    );
    await expect
      .poll(() => document.querySelector("pre")?.textContent)
      .toContain("const shown = 1;");
  });
});

describe("malicious content renders as inert text", () => {
  const evil = [
    '<img src=x onerror="window.__pwn=1">',
    "<script>window.__pwn = 2</script>",
    '<a href="javascript:window.__pwn=3">go</a>',
    "**bold** # heading [link](javascript:window.__pwn=4) `tick`",
    '<style>body{display:none}</style><iframe src="//evil.example"></iframe>',
  ].join("\n");

  it("creates no elements from HTML or Markdown and runs nothing", async () => {
    const { highlighter } = setup();
    await render(<CodeBody text={evil} language="md" privacy={false} highlighter={highlighter} />);
    await expect
      .poll(() => document.querySelector("pre")?.textContent ?? "")
      .toContain("<script>window.__pwn = 2</script>");
    const pre = document.querySelector("pre") as HTMLElement;
    expect(pre.textContent).toContain("**bold** # heading [link](javascript:window.__pwn=4)");
    expect(pre.querySelector("img, script, a, iframe, style, strong, b, h1, code")).toBeNull();
    expect(document.querySelector("a[href^='javascript' i]")).toBeNull();
    expect((window as unknown as { __pwn?: number }).__pwn).toBeUndefined();
  });

  it("treats hostile tokens from the highlighter as text and ignores unsafe colors", async () => {
    const { highlighter } = setup(() => [
      [
        { content: "<b onmouseover=alert(1)>x</b>", color: "#ff0000" },
        { content: "styled", color: "red;background:url(javascript:alert(1))" },
        { content: "ok", color: "var(--x)" },
      ],
    ]);
    await render(
      <CodeBody text="ignored" language="ts" privacy={false} highlighter={highlighter} />,
    );
    await expect
      .poll(() => document.querySelector("pre")?.textContent ?? "")
      .toContain("<b onmouseover=alert(1)>x</b>");
    const pre = document.querySelector("pre") as HTMLElement;
    expect(pre.querySelector("b")).toBeNull();
    const styles = [...pre.querySelectorAll("[style]")].map((el) => el.getAttribute("style") ?? "");
    expect(styles.join(";")).not.toMatch(/url|javascript|background/i);
    expect(styles.some((s) => /#ff0000|rgb\(255, 0, 0\)/i.test(s))).toBe(true);
  });

  it("shows bidi and invisible characters as visible <U+XXXX> markers", async () => {
    const { highlighter } = setup();
    await render(
      <CodeBody
        text={`access${RLO}Level${ZWSP}x`}
        language="ts"
        privacy={false}
        highlighter={highlighter}
      />,
    );
    await expect
      .poll(() => document.querySelector("pre")?.textContent ?? "")
      .toContain("access<U+202E>Level<U+200B>x");
    expect(document.querySelector("pre")?.textContent).not.toContain(RLO);
  });
});

describe("secrets are masked before the highlighter sees them", () => {
  it("masks a raw token even when no mask spans were supplied", async () => {
    const { highlighter, calls } = setup();
    await render(
      <CodeBody
        text={`const t = "${GHP}";`}
        language="ts"
        privacy={false}
        highlighter={highlighter}
      />,
    );
    await expect
      .poll(() => document.querySelector("pre")?.textContent ?? "")
      .toContain("[REDACTED:github-token]");
    expect(document.body.textContent).not.toContain(GHP);
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) expect(call.text).not.toContain(GHP);
  });

  it("keeps markers the engine already inserted", async () => {
    const { highlighter } = setup();
    await render(
      <CodeBody
        text={"key = [REDACTED:openai-key]"}
        language="ts"
        privacy={false}
        highlighter={highlighter}
      />,
    );
    await expect
      .poll(() => document.querySelector("pre")?.textContent ?? "")
      .toContain("key = [REDACTED:openai-key]");
  });
});
