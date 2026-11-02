import { describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";
import { AGENT, build } from "../live/liveKit.tsx";
import { FilesTab } from "./FilesTab.tsx";

// M5.23 red round 2 (roborev 6653, FilesTab.tsx:122): under privacy a row must keep its identity
// when the list reorders. A focused row button must stay on the same file, so Enter opens the
// file that was focused, and the full paths must stay out of the DOM (a stable key must not be
// the path).

const A = `/r/${"a".repeat(1000)}/PATH_SENTINEL_A/${"a".repeat(1000)}/alpha-end.ts`;
const B = `/r/${"b".repeat(1000)}/PATH_SENTINEL_B/${"b".repeat(1000)}/bravo-end.ts`;
const C = `/r/${"c".repeat(1000)}/PATH_SENTINEL_C/${"c".repeat(1000)}/charlie-end.ts`;

const framesFor = (paths: string[]) =>
  build(paths.map((p, i) => ({ id: `ri-${i}`, tool: "Edit", filePaths: [p] }))).calls.map(
    (data, i) => ({ id: i + 1, data }),
  );

describe("Files tab row identity under privacy", () => {
  it("keeps a focused row on its file when a new file reorders the list", async () => {
    const view = await render(
      <FilesTab agentId={AGENT} frames={framesFor([A, B])} evidence={{}} privacy />,
    );
    // Newest first: B then A. Focus the A row (second).
    const rows = () => page.getByTestId("file-row").elements() as HTMLElement[];
    const rowA = rows().find((r) => r.textContent?.includes("alpha-end.ts"));
    expect(rowA).toBeDefined();
    rowA?.focus();
    expect(document.activeElement).toBe(rowA);

    // C arrives and sorts first: every index shifts by one.
    await view.rerender(
      <FilesTab agentId={AGENT} frames={framesFor([A, B, C])} evidence={{}} privacy />,
    );
    await expect.poll(() => rows().length).toBe(3);

    expect(document.activeElement?.textContent).toContain("alpha-end.ts");
    await userEvent.keyboard("{Enter}");
    const heading = page.getByTestId("file-edits").getByRole("heading", { level: 3 });
    await expect.element(heading).toHaveTextContent("alpha-end.ts");
    expect(heading.element().textContent).not.toContain("bravo-end.ts");
    expect(heading.element().textContent).not.toContain("charlie-end.ts");

    const html = view.container.innerHTML;
    for (const full of [A, B, C]) expect(html).not.toContain(full);
    for (const mid of ["PATH_SENTINEL_A", "PATH_SENTINEL_B", "PATH_SENTINEL_C"])
      expect(html).not.toContain(mid);
  });
});
