import { describe, expect, it } from "vitest";
import { page } from "vitest/browser";
import {
  articles,
  type CallSpec,
  paint,
  renderConstrained,
  renderPlain,
  slot,
} from "./liveKit.tsx";

// M5.06 round 5 item D: accessibility of the Live tab.
const escapeRe = (text: string) => text.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");
const write = (n: number): CallSpec => ({
  id: `a11y-write-${n}`,
  tool: "Write",
  input: { file_path: `/r5/a11y/file-${String(n).padStart(3, "0")}.txt`, content: `body ${n}` },
  filePaths: [`/r5/a11y/file-${String(n).padStart(3, "0")}.txt`],
  durationMs: 1,
});
const stdout = (tag: string) => Array.from({ length: 12 }, (_, i) => `${tag}-${i}`).join("\n");
const bash = (n: number, command: string): CallSpec => ({
  id: `a11y-bash-${n}`,
  tool: "Bash",
  input: { command },
  output: { stdout: stdout(`o${n}`), stderr: "" },
  durationMs: 2,
});

describe("D: each card is an article with an accessible name", () => {
  it("names a Bash, Write and Edit card by tool and subject", async () => {
    await renderPlain([
      bash(1, "pnpm test --filter alpha"),
      {
        id: "a11y-write-x",
        tool: "Write",
        input: { file_path: "/r5/write-target.txt", content: "w" },
        filePaths: ["/r5/write-target.txt"],
        durationMs: 1,
      },
      {
        id: "a11y-edit-x",
        tool: "Edit",
        input: { file_path: "/r5/edit-target.ts", old_string: "one", new_string: "two" },
        filePaths: ["/r5/edit-target.ts"],
        durationMs: 1,
      },
    ]);
    await expect.poll(() => articles().elements()).toHaveLength(3);
    const named = (tool: string, subject: string) =>
      page.getByRole("article", { name: new RegExp(`${tool}.*${escapeRe(subject)}`, "i") });
    expect(named("Bash", "pnpm test --filter alpha").elements()).toHaveLength(1);
    expect(named("Write", "/r5/write-target.txt").elements()).toHaveLength(1);
    expect(named("Edit", "/r5/edit-target.ts").elements()).toHaveLength(1);
    // The name comes from the card's own heading through aria-labelledby, not from a copy.
    for (const card of articles().elements()) {
      const ids = (card.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const target = document.getElementById(id);
        expect(target).not.toBeNull();
        expect(card.contains(target)).toBe(true);
        expect(target?.textContent?.trim()).not.toBe("");
      }
    }
  });

  it("Expand output buttons name their own card", async () => {
    await renderPlain([bash(1, "echo first-card"), bash(2, "echo second-card")]);
    await expect.poll(() => articles().elements()).toHaveLength(2);
    const [first, second] = articles().elements();
    const firstButton = page.getByRole("button", { name: /expand output.*first-card/i });
    const secondButton = page.getByRole("button", { name: /expand output.*second-card/i });
    expect(firstButton.elements()).toHaveLength(1);
    expect(secondButton.elements()).toHaveLength(1);
    expect(first.contains(firstButton.element())).toBe(true);
    expect(second.contains(secondButton.element())).toBe(true);
    // Still reachable by the plain name, inside each card.
    expect(page.getByRole("button", { name: /expand output/i }).elements()).toHaveLength(2);
  });
});

describe("D: Jump to latest moves focus to the newest card", () => {
  it("focuses the newest card, not the body, after Jump to latest", async () => {
    const specs = Array.from({ length: 40 }, (_, i) => write(i));
    await renderConstrained(specs);
    const viewport = slot().element();
    viewport.scrollTop = viewport.scrollHeight;
    await paint();
    viewport.scrollTop = Math.max(0, viewport.scrollTop - viewport.clientHeight);
    await paint();
    const jump = slot().getByRole("button", { name: /jump to latest/i });
    await expect.element(jump, { timeout: 800 }).toBeVisible();
    await jump.click();
    const newest = () =>
      articles()
        .elements()
        .find((el) => el.textContent?.includes("file-039.txt"));
    await expect.poll(() => newest() !== undefined).toBe(true);
    await expect.poll(() => newest()?.contains(document.activeElement)).toBe(true);
    expect(document.activeElement).not.toBe(document.body);
    expect(slot().element().contains(document.activeElement)).toBe(true);
  });
});

describe("D: the list is a feed with set size and position", () => {
  it("exposes role=feed and aria-setsize/aria-posinset on every mounted item", async () => {
    const specs = Array.from({ length: 40 }, (_, i) => write(i));
    await renderConstrained(specs);
    const feeds = page.getByRole("feed");
    expect(feeds.elements()).toHaveLength(1);
    const feed = feeds.element();
    const mounted = articles().elements();
    expect(mounted.length).toBeGreaterThan(0);
    for (const card of mounted) {
      expect(feed.contains(card)).toBe(true);
      const n = Number(card.textContent?.match(/file-(\d+)\.txt/)?.[1]);
      expect(card.getAttribute("aria-setsize")).toBe("40");
      expect(card.getAttribute("aria-posinset")).toBe(String(n + 1));
    }
  });
});
