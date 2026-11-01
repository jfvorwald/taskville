import { describe, expect, it } from "vitest";
import { articles, type CallSpec, paint, renderPlain } from "./liveKit.tsx";

// M5.06 pin round 6: fixes that landed without a test. Everything here is synthetic.
// Search group file lists (94154e8), group phases and the Edit cap with markers (d0dd2c4).
// These use renderPlain and their own specs only; no shared fixture is touched.

const search = (n: number, extra: Partial<CallSpec> = {}): CallSpec => ({
  id: `p6-grep-${n}`,
  tool: "Grep",
  input: { pattern: `pattern-${n}`, path: "/p6/src" },
  durationMs: 3,
  ...extra,
});
const read = (n: number, phase: NonNullable<CallSpec["phase"]>): CallSpec => ({
  id: `p6-read-${n}`,
  tool: "Read",
  input: { file_path: `/p6/read/file-${n}.ts` },
  filePaths: [`/p6/read/file-${n}.ts`],
  phase,
  durationMs: 2,
});
const items = (card: Element) =>
  Array.from(card.querySelectorAll("li"), (li) => li.textContent?.trim() ?? "");
const expand = async () => {
  await articles()
    .getByRole("button", { name: /expand/i })
    .click();
  return articles().element();
};

describe("94154e8: an expanded Search group lists the files each search recorded", () => {
  it("shows each search's own frame file paths next to its pattern", async () => {
    await renderPlain([
      search(1, { filePaths: ["/p6/src/hit-a.ts", "/p6/src/hit-b.ts"] }),
      search(2, { filePaths: ["/p6/src/hit-c.ts"] }),
      search(3, { filePaths: [] }),
    ]);
    await expect.poll(() => articles().elements().length).toBe(1);
    await expect.element(articles()).toMatchTextContent("Searched 3 times");
    const list = items(await expand());
    expect(list).toHaveLength(3);
    expect(list[0]).toContain("pattern-1");
    expect(list[0]).toContain("/p6/src/hit-a.ts");
    expect(list[0]).toContain("/p6/src/hit-b.ts");
    expect(list[0]).not.toContain("hit-c.ts");
    expect(list[1]).toContain("pattern-2");
    expect(list[1]).toContain("/p6/src/hit-c.ts");
    expect(list[1]).not.toContain("hit-a.ts");
    expect(list[2]).toContain("pattern-3");
    expect(list[2]).not.toContain("/p6/src/");
  });

  it("also lists files from the recorded result, once when the frame repeats them", async () => {
    await renderPlain([
      search(1, {
        filePaths: ["/p6/src/both.ts"],
        output: { filenames: ["/p6/src/both.ts", "/p6/src/only-result.ts"], numFiles: 2 },
      }),
      search(2, { filePaths: ["/p6/src/other.ts"] }),
    ]);
    await expect.poll(() => articles().elements().length).toBe(1);
    const list = items(await expand());
    expect(list[0]).toContain("/p6/src/only-result.ts");
    expect(list[0].split("/p6/src/both.ts")).toHaveLength(2);
    expect(list[1]).toContain("/p6/src/other.ts");
  });
});

describe("d0dd2c4: a group never presents running or failed calls as all succeeded", () => {
  it("shows a count of running and failed calls and a phase on each unsettled call", async () => {
    await renderPlain([
      read(1, "succeeded"),
      read(2, "running"),
      read(3, "failed"),
      read(4, "failed"),
    ]);
    await expect.poll(() => articles().elements().length).toBe(1);
    const card = articles().element();
    expect(card.textContent).toContain("Read 4 files");
    // The card's text nodes run together without spaces, so only a digit may not precede a count.
    expect(card.textContent).toMatch(/(?<!\d)1 running/);
    expect(card.textContent).toMatch(/(?<!\d)2 failed/);
    const list = items(await expand());
    expect(list).toHaveLength(4);
    expect(list[0]).toContain("file-1.ts");
    expect(list[0]).not.toMatch(/running|failed|unfinished/);
    expect(list[1]).toContain("file-2.ts");
    expect(list[1]).toMatch(/running/);
    expect(list[1]).not.toMatch(/failed/);
    expect(list[2]).toContain("file-3.ts");
    expect(list[2]).toMatch(/failed/);
    expect(list[3]).toContain("file-4.ts");
    expect(list[3]).toMatch(/failed/);
  });

  it("counts unfinished calls in a Search group too", async () => {
    await renderPlain([
      search(1, { phase: "succeeded" }),
      search(2, { phase: "unfinished" }),
      search(3, { phase: "unfinished" }),
    ]);
    await expect.poll(() => articles().elements().length).toBe(1);
    expect(articles().element().textContent).toMatch(/(?<!\d)2 unfinished/);
    expect(articles().element().textContent).not.toMatch(/running|failed/);
    const list = items(await expand());
    expect(list[0]).not.toMatch(/unfinished/);
    expect(list[1]).toMatch(/unfinished/);
    expect(list[2]).toMatch(/unfinished/);
  });

  it("says nothing about phases when every call succeeded", async () => {
    await renderPlain([read(1, "succeeded"), read(2, "succeeded")]);
    await expect.poll(() => articles().elements().length).toBe(1);
    const card = await expand();
    expect(card.textContent).not.toMatch(/running|failed|unfinished/);
    for (const text of items(card)) expect(text).not.toMatch(/running|failed|unfinished/);
  });
});

describe("d0dd2c4: the Edit cap counts the <U+XXXX> markers it shows", () => {
  // Built from code points so no invisible character sits in this source. One tag character is
  // 2 UTF-16 units and shows as the 9 character marker <U+E0061>, so 4000 of them show 36,000.
  const TAG = String.fromCodePoint(0xe0061);
  const MARKER = "<U+E0061>";
  const CAP = 20_000;
  const textOf = (card: Element, selector: string) =>
    Array.from(card.querySelectorAll(selector), (el) => el.textContent ?? "").join("");

  it("keeps the rendered old and new text within 20,000 characters, whole markers only", async () => {
    await renderPlain([
      {
        id: "p6-edit",
        tool: "Edit",
        input: {
          file_path: "/p6/edit.ts",
          old_string: `start ${TAG.repeat(4000)}`,
          new_string: `finish ${TAG.repeat(4000)}`,
        },
        filePaths: ["/p6/edit.ts"],
        durationMs: 1,
      },
    ]);
    await expect.poll(() => articles().elements().length, { timeout: 10_000 }).toBe(1);
    await paint();
    const card = articles().element();
    const text = card.textContent ?? "";
    // Markers were shown, and the note says the display was cut.
    expect(text).toContain(MARKER);
    expect(text).toMatch(/truncated/i);
    // The old side (removed and unchanged parts) and the new side each stay within the cap.
    const old = textOf(card, "del") + textOf(card, "span");
    const added = textOf(card, "ins") + textOf(card, "span");
    expect(old.length).toBeLessThanOrEqual(CAP);
    expect(added.length).toBeLessThanOrEqual(CAP);
    expect(text.length).toBeLessThanOrEqual(CAP * 2 + 1000);
    // A marker is never cut in half: removing whole markers leaves no marker fragment.
    const stripped = text.replaceAll(MARKER, "");
    expect(stripped).not.toMatch(/<U\+|U\+E0|E0061>/);
  });
});
