import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";
import type { ToolCallFrame } from "../../../../../engine/src/feed/subscriber.ts";
import "../../../styles/tokens.css";
import { FilesTab } from "./FilesTab.tsx";
import recorded from "./recorded-feed.fixture.json";

// M10.03 red: Files rows (design 2026-11-08-agent-panel-readability): file name in the mono token
// font, directory muted, edit count right-aligned within the row.

type Frame = { id: number; data: ToolCallFrame };
const frames = recorded.frames as Frame[];
const SESSION = "claude-code:1469cdbe-10a8-4b66-bb64-bcf51f4f2bf5";
const A = `${SESSION}:afdf84bea07a9064c`;
const NAME = "notes.txt";
const DIR = "/tmp/spike-s2/proj";

async function mount() {
  return render(
    <div style={{ width: 400 }}>
      <FilesTab agentId={A} frames={frames} />
    </div>,
  );
}

const probe = (prop: "color" | "fontFamily", value: string) => {
  const el = document.createElement("span");
  el.style.setProperty(prop === "color" ? "color" : "font-family", value);
  document.body.append(el);
  const out = getComputedStyle(el)[prop];
  el.remove();
  return out;
};
const leaf = (row: Element, match: (text: string) => boolean) =>
  Array.from(row.querySelectorAll("*")).find(
    (el) => el.children.length === 0 && match((el.textContent ?? "").trim()),
  ) as HTMLElement | undefined;

describe("Files row layout", () => {
  it("shows the file name in the mono token font", async () => {
    await mount();
    const row = page.getByTestId("file-row").element();
    const name = leaf(row, (t) => t === NAME);
    expect(name, "an element holding only the file name").toBeDefined();
    expect(getComputedStyle(name as HTMLElement).fontFamily).toBe(
      probe("fontFamily", "var(--tv-mono)"),
    );
  });

  it("shows the directory muted, apart from the name", async () => {
    await mount();
    const row = page.getByTestId("file-row").element();
    const dir = leaf(row, (t) => t.replace(/\/$/, "") === DIR);
    expect(dir, "an element holding only the directory").toBeDefined();
    const muted = probe("color", "var(--tv-text-muted)");
    expect(getComputedStyle(dir as HTMLElement).color).toBe(muted);
    const name = leaf(row, (t) => t === NAME) as HTMLElement;
    expect(getComputedStyle(name).color).not.toBe(muted);
  });

  it("right-aligns the edit count with the row's right edge", async () => {
    await mount();
    const row = page.getByTestId("file-row").element();
    const count = leaf(row, (t) => /^1 edit/.test(t));
    expect(count, "an element holding the edit count").toBeDefined();
    const rowBox = row.getBoundingClientRect();
    const box = (count as HTMLElement).getBoundingClientRect();
    expect(rowBox.right - box.right).toBeLessThanOrEqual(12);
    expect(rowBox.right - box.right).toBeGreaterThanOrEqual(0);
    expect(box.left).toBeGreaterThan(rowBox.left + rowBox.width / 2);
  });
});

describe("Files row with a Windows path", () => {
  it("splits on the backslash: muted directory, file name as the name", async () => {
    const win = "C:\\repo\\src\\a.ts";
    const winFrames = frames.map((f) => ({
      ...f,
      data: f.data.agentId === A ? { ...f.data, filePaths: [win] } : f.data,
    })) as Frame[];
    await render(
      <div style={{ width: 400 }}>
        <FilesTab agentId={A} frames={winFrames} />
      </div>,
    );
    const row = page.getByTestId("file-row").element();
    const name = leaf(row, (t) => t === "a.ts");
    expect(name, "an element holding only the file name").toBeDefined();
    const dir = leaf(row, (t) => t.replace(/[\\/]$/, "") === "C:\\repo\\src");
    expect(dir, "an element holding only the directory").toBeDefined();
    expect(getComputedStyle(dir as HTMLElement).color).toBe(probe("color", "var(--tv-text-muted)"));
  });
});
