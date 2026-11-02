import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AGENT, build } from "../live/liveKit.tsx";
import { FilesTab } from "./FilesTab.tsx";

// M5.23 red (issue #338): under Hide code the Files tab must not carry content in a recorded
// path: not in the row text, the detail heading, the section aria-label, or any attribute.

const MULTI = "/r/src/a.ts\nconst PATH_SENTINEL_FILES = secret();\nexport {};";
const LONG = `/r/${"a".repeat(1990)}/PATH_SENTINEL_LONG/${"b".repeat(1990)}/end.ts`;

async function open(privacy: boolean, path: string) {
  const { calls, evidence } = build([{ id: "f1", tool: "Edit", filePaths: [path] }]);
  const frames = calls.map((data, i) => ({ id: i + 1, data }));
  const view = await render(
    <FilesTab agentId={AGENT} frames={frames} evidence={evidence} privacy={privacy} />,
  );
  await view.getByTestId("file-row").click();
  await expect.element(page.getByTestId("file-edits")).toBeVisible();
  const root = view.container;
  const label = page.getByTestId("file-edits").element().getAttribute("aria-label") ?? "";
  return { text: root.textContent ?? "", html: root.innerHTML, label };
}

describe("Files tab paths under privacy", () => {
  it("shows the path in text and aria-label with privacy off (baseline)", async () => {
    const { text, label } = await open(false, "/r/src/a.ts");
    expect(text).toContain("/r/src/a.ts");
    expect(label).toBe("Edits to /r/src/a.ts");
  });

  it("hides a multi-line path in text, aria-label and attributes", async () => {
    const { text, html, label } = await open(true, MULTI);
    expect(text).toContain("path hidden");
    for (const out of [text, html, label]) {
      expect(out).not.toContain("PATH_SENTINEL_FILES");
      expect(out).not.toContain("secret()");
    }
  });

  it("bounds a 4,000 character path in text, aria-label and attributes", async () => {
    const { text, html, label } = await open(true, LONG);
    for (const out of [text, html, label]) {
      expect(out).not.toContain(LONG);
      expect(out).not.toContain("PATH_SENTINEL_LONG");
    }
    expect(label.length).toBeLessThan(300);
    expect(html.length).toBeLessThan(5000);
  });
});
