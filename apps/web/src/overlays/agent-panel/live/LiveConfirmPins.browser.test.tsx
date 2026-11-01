import { describe, expect, it } from "vitest";
import {
  articles,
  type CallSpec,
  paint,
  renderConstrained,
  renderPlain,
  slot,
} from "./liveKit.tsx";

// M5.06 pin round 6, confirm review: Edit and Write render caps, and the grouped card contract.
// Synthetic. These use their own specs and renderers; no shared fixture is touched.

const CAP = 20_000;
const BEL = String.fromCodePoint(0x07);
const preLengths = (card: Element) =>
  Array.from(card.querySelectorAll("pre"), (pre) => pre.textContent?.length ?? 0);
const textOf = (card: Element, selector: string) =>
  Array.from(card.querySelectorAll(selector), (el) => el.textContent ?? "").join("");

describe("render cap: an Edit or Write body over 20,000 characters is cut with a note", () => {
  const edit = (oldString: string, newString: string): CallSpec => ({
    id: "c6-edit",
    tool: "Edit",
    input: { file_path: "/c6/edit.ts", old_string: oldString, new_string: newString },
    filePaths: ["/c6/edit.ts"],
    durationMs: 1,
  });
  const write = (content: string): CallSpec => ({
    id: "c6-write",
    tool: "Write",
    input: { file_path: "/c6/write.txt", content },
    filePaths: ["/c6/write.txt"],
    durationMs: 1,
  });
  const card = async (spec: CallSpec) => {
    await renderPlain([spec]);
    await expect.poll(() => articles().elements().length, { timeout: 10_000 }).toBe(1);
    await paint();
    return articles().element();
  };

  it("caps an Edit with 30,000 visible characters", async () => {
    const el = await card(edit("word ".repeat(6000), "x"));
    expect(el.textContent).toMatch(/truncated at 20,000/i);
    // The old side is the removed and unchanged parts, or the original fragment.
    const old = textOf(el, "del") + textOf(el, "span") + preLengths(el).join("");
    expect(old.length).toBeLessThanOrEqual(CAP + 10);
    for (const length of preLengths(el)) expect(length).toBeLessThanOrEqual(CAP);
    expect(el.textContent?.length ?? 0).toBeLessThanOrEqual(CAP * 2 + 1000);
  });

  it("caps an Edit whose hidden characters take it over 20,000 once shown", async () => {
    // 3,000 raw characters, each shown as the 8 character marker <U+0007>: 24,000 shown.
    const el = await card(edit(`${BEL.repeat(3000)}end`, "short"));
    expect(el.textContent).toMatch(/truncated at 20,000/i);
    expect(el.textContent).toContain("<U+0007>");
    const old = textOf(el, "del") + textOf(el, "span");
    expect(old.length).toBeLessThanOrEqual(CAP);
    for (const length of preLengths(el)) expect(length).toBeLessThanOrEqual(CAP);
  });

  it("caps a Write with 30,000 visible characters", async () => {
    const el = await card(write("line\n".repeat(6000)));
    expect(el.textContent).toMatch(/truncated at 20,000/i);
    const lengths = preLengths(el);
    expect(lengths.length).toBeGreaterThan(0);
    for (const length of lengths) expect(length).toBeLessThanOrEqual(CAP);
    expect(el.textContent?.length ?? 0).toBeLessThanOrEqual(CAP + 1000);
  });

  it("caps a Write whose hidden characters take it over 20,000 once shown", async () => {
    const el = await card(write(BEL.repeat(3000)));
    expect(el.textContent).toMatch(/truncated at 20,000/i);
    expect(el.textContent).toContain("<U+0007>");
    for (const length of preLengths(el)) expect(length).toBeLessThanOrEqual(CAP);
    expect(el.textContent?.length ?? 0).toBeLessThanOrEqual(CAP + 1000);
  });

  it("does not add the note to an Edit and a Write under the cap", async () => {
    await renderPlain([edit("small old", "small new"), write("small content")]);
    await expect.poll(() => articles().elements().length).toBe(2);
    expect(slot().element().textContent).not.toMatch(/truncated at 20,000/i);
  });
});

const read = (n: number): CallSpec => ({
  id: `c6-read-${n}`,
  tool: "Read",
  input: { file_path: `/c6/read/file-${n}.ts` },
  filePaths: [`/c6/read/file-${n}.ts`],
  durationMs: 2,
});
const grep = (n: number): CallSpec => ({
  id: `c6-grep-${n}`,
  tool: "Grep",
  input: { pattern: `grep-pattern-${n}` },
  durationMs: 2,
});
const glob = (n: number): CallSpec => ({
  id: `c6-glob-${n}`,
  tool: "Glob",
  input: { pattern: `glob-pattern-${n}` },
  durationMs: 2,
});
const note: CallSpec = {
  id: "c6-note",
  tool: "Write",
  input: { file_path: "/c6/note.txt", content: "n" },
  filePaths: ["/c6/note.txt"],
  durationMs: 1,
};
const bash: CallSpec = {
  id: "c6-bash",
  tool: "Bash",
  input: { command: "echo c6" },
  output: { stdout: "c6\n", stderr: "" },
  durationMs: 1,
};

describe("group cards in the feed", () => {
  it("a Read group and a Search group (Grep then Glob) are named articles with position and size", async () => {
    await renderPlain([note, read(1), read(2), grep(1), glob(1), bash]);
    // Write, Read group, Search group, Bash: four items, not six calls.
    await expect.poll(() => articles().elements().length).toBe(4);
    const [first, readGroup, searchGroup, last] = articles().elements();
    expect(readGroup.textContent).toContain("Read 2 files");
    expect(searchGroup.textContent).toContain("Searched 2 times");
    expect(first.textContent).not.toContain("Read 2 files");
    expect(last.textContent).toContain("echo c6");
    const feed = document.querySelector('[role="feed"]');
    expect(feed).not.toBeNull();
    for (const [card, position] of [
      [readGroup, "2"],
      [searchGroup, "3"],
    ] as const) {
      expect(feed?.contains(card)).toBe(true);
      expect(card.getAttribute("aria-setsize")).toBe("4");
      expect(card.getAttribute("aria-posinset")).toBe(position);
      const ids = (card.getAttribute("aria-labelledby") ?? "").split(/\s+/).filter(Boolean);
      expect(ids.length).toBeGreaterThan(0);
      for (const id of ids) {
        const target = document.getElementById(id);
        expect(target).not.toBeNull();
        expect(card.contains(target)).toBe(true);
        expect(target?.textContent?.trim()).not.toBe("");
      }
    }
    // The accessible name comes from that heading.
    expect(
      slot()
        .getByRole("article", { name: /Read 2 files/ })
        .elements(),
    ).toHaveLength(1);
    expect(
      slot()
        .getByRole("article", { name: /Searched 2 times/ })
        .elements(),
    ).toHaveLength(1);
  });

  it("a single Search is an ordinary card, not a group", async () => {
    await renderPlain([grep(1)]);
    await expect.poll(() => articles().elements().length).toBe(1);
    const card = articles().element();
    expect(card.textContent).toContain("grep-pattern-1");
    expect(card.textContent).not.toMatch(/Searched \d+ times?/);
    expect(card.querySelector("ul, ol")).toBeNull();
    expect(
      slot()
        .getByRole("button", { name: /expand patterns/i })
        .elements(),
    ).toHaveLength(0);
  });

  it("a Search group stays expanded when it grows by one call", async () => {
    const { rerender } = await renderConstrained([grep(1), glob(1)]);
    await expect.poll(() => articles().elements().length).toBe(1);
    await expect.element(articles()).toMatchTextContent("Searched 2 times");
    const toggle = () => articles().getByRole("button", { name: /expand patterns/i });
    await toggle().click();
    expect(toggle().element().getAttribute("aria-expanded")).toBe("true");
    expect(articles().element().querySelectorAll("li")).toHaveLength(2);

    await rerender([grep(1), glob(1), grep(2)]);
    await expect.poll(() => articles().elements().length).toBe(1);
    await expect.element(articles()).toMatchTextContent("Searched 3 times");
    expect(toggle().element().getAttribute("aria-expanded")).toBe("true");
    const items = Array.from(articles().element().querySelectorAll("li"), (li) => li.textContent);
    expect(items).toHaveLength(3);
    expect(items[2]).toContain("grep-pattern-2");
  });

  it("a Read group stays expanded when it grows by one call", async () => {
    const { rerender } = await renderConstrained([read(1), read(2)]);
    await expect.poll(() => articles().elements().length).toBe(1);
    const toggle = () => articles().getByRole("button", { name: /expand paths/i });
    await toggle().click();
    expect(toggle().element().getAttribute("aria-expanded")).toBe("true");

    await rerender([read(1), read(2), read(3)]);
    await expect.element(articles()).toMatchTextContent("Read 3 files");
    expect(toggle().element().getAttribute("aria-expanded")).toBe("true");
    expect(articles().element().querySelectorAll("li")).toHaveLength(3);
  });
});
