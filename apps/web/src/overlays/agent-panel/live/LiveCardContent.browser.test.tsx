import { afterEach, describe, expect, it, vi } from "vitest";
import { articles, type CallSpec, paint, renderPlain, slot } from "./liveKit.tsx";

// M5.06 round 5 items B (repeated diff tokens), C (grouped Read and Search) and F (Bash tail).

afterEach(() => {
  vi.restoreAllMocks();
});

describe("B: Edit diff with repeated tokens", () => {
  it.each([
    ["a a", "b b", "aa", "bb"],
    ["x y x", "z y z", "xx", "zz"],
  ])(
    "renders %j to %j as the right removed and added parts with no duplicate-key warning",
    async (oldString, newString, removed, added) => {
      const errors = vi.spyOn(console, "error").mockImplementation(() => {});
      await renderPlain([
        {
          id: "edit-1",
          tool: "Edit",
          input: { file_path: "/r5/repeat.ts", old_string: oldString, new_string: newString },
          filePaths: ["/r5/repeat.ts"],
        },
      ]);
      const edit = articles().element();
      await paint();
      const text = (selector: string) =>
        Array.from(edit.querySelectorAll(selector), (el) => el.textContent).join("");
      expect(text("del")).toBe(removed);
      expect(text("ins")).toBe(added);
      // Every removed token appears once, not once per equal sibling.
      expect(edit.querySelectorAll("del")).not.toHaveLength(0);
      const warned = errors.mock.calls.filter((args) =>
        args.some((arg) => /same key|unique "key"|duplicate key/i.test(String(arg))),
      );
      expect(warned).toEqual([]);
    },
  );
});

const read = (n: number, extra: Partial<CallSpec> = {}): CallSpec => ({
  id: `read-${n}`,
  tool: "Read",
  input: { file_path: `/r5/src/file-${n}.ts` },
  output: {
    type: "text",
    file: {
      filePath: `/r5/src/file-${n}.ts`,
      content: `FILE-CONTENT-MARKER-${n}\nconst x = ${n};\n`,
      numLines: 2,
      startLine: 1,
      totalLines: 2,
    },
  },
  filePaths: [`/r5/src/file-${n}.ts`],
  durationMs: 4 + n,
  ...extra,
});
const grep = (n: number, pattern: string): CallSpec => ({
  id: `grep-${n}`,
  tool: "Grep",
  input: { pattern, path: "/r5/src" },
  output: { filenames: [`/r5/src/hit-${n}.ts`], numFiles: 1, content: `GREP-CONTENT-MARKER-${n}` },
  filePaths: [`/r5/src/hit-${n}.ts`],
  durationMs: 9,
});
const bash = (n: number): CallSpec => ({
  id: `bash-${n}`,
  tool: "Bash",
  input: { command: `echo between-${n}` },
  output: { stdout: `between-${n}\n`, stderr: "" },
  durationMs: 3,
});

const cardCount = (count: number) =>
  expect.poll(() => articles().elements().length, { timeout: 1500 }).toBe(count);

describe("C: consecutive Read and Search calls group into one card (ARCHITECTURE 2.10)", () => {
  // Pinned wording: "Read N files" and "Searched N times". A run of Read calls and a run of
  // Search calls (Grep, Glob, Search) are separate groups. Any other call between ends a group.
  it("groups three consecutive Reads into one card that says Read 3 files and expands to the paths", async () => {
    await renderPlain([read(1), read(2), read(3)]);
    await cardCount(1);
    await expect.element(articles()).toMatchTextContent("Read 3 files");
    const group = articles();
    const toggle = group.getByRole("button", { name: /expand/i });
    expect(toggle.element().getAttribute("aria-expanded")).toBe("false");
    await toggle.click();
    expect(toggle.element().getAttribute("aria-expanded")).toBe("true");
    const items = Array.from(group.element().querySelectorAll("li"), (li) =>
      li.textContent?.trim(),
    );
    expect(items).toEqual(["/r5/src/file-1.ts", "/r5/src/file-2.ts", "/r5/src/file-3.ts"]);
    expect(group.element().querySelector("ul, ol")).not.toBeNull();
  });

  it("never dumps the Read output JSON or file contents, and never says not reported", async () => {
    await renderPlain([read(1), read(2), read(3)]);
    await cardCount(1);
    await expect.element(articles()).toMatchTextContent("Read 3 files");
    await articles()
      .getByRole("button", { name: /expand/i })
      .click();
    const text = articles().element().textContent ?? "";
    expect(text).not.toContain("FILE-CONTENT-MARKER");
    expect(text).not.toMatch(/const x =|"content"|"filePath"|"numLines"|"type"/);
    expect(text).not.toMatch(/not reported/i);
  });

  it("a single Read with a file_path input names the file, not not reported, and hides the content", async () => {
    // filePaths is empty on purpose: the file comes from the recorded input.
    await renderPlain([read(1, { filePaths: [] })]);
    await cardCount(1);
    await expect.element(articles()).toMatchTextContent("/r5/src/file-1.ts");
    const text = articles().element().textContent ?? "";
    expect(text).toMatch(/read/i);
    expect(text).not.toMatch(/not reported/i);
    expect(text).not.toContain("FILE-CONTENT-MARKER");
    expect(text).not.toMatch(/"content"|"filePath"/);
  });

  it("groups two consecutive Search calls into one card that says Searched 2 times and expands to the patterns", async () => {
    await renderPlain([grep(1, "attention"), grep(2, "focus ring")]);
    await cardCount(1);
    await expect.element(articles()).toMatchTextContent("Searched 2 times");
    const group = articles();
    await group.getByRole("button", { name: /expand/i }).click();
    const items = Array.from(group.element().querySelectorAll("li"), (li) =>
      li.textContent?.trim(),
    );
    expect(items).toHaveLength(2);
    expect(items[0]).toContain("attention");
    expect(items[1]).toContain("focus ring");
    expect(group.element().textContent).not.toContain("GREP-CONTENT-MARKER");
  });

  it("keeps a run of Reads and a run of Searches as separate cards, in order", async () => {
    await renderPlain([read(1), read(2), grep(1, "alpha"), grep(2, "beta")]);
    await cardCount(2);
    const [first, second] = articles().elements();
    expect(first.textContent).toContain("Read 2 files");
    expect(second.textContent).toContain("Searched 2 times");
  });

  it("an interleaved call ends the group: Read, Read, Bash, Read is three cards", async () => {
    await renderPlain([read(1), read(2), bash(1), read(3)]);
    await cardCount(3);
    const [first, second, third] = articles().elements();
    expect(first.textContent).toContain("Read 2 files");
    expect(second.textContent).toContain("echo between-1");
    expect(third.textContent).toContain("/r5/src/file-3.ts");
    expect(third.textContent).not.toContain("Read 2 files");
    expect(slot().element().textContent).not.toContain("Read 3 files");
  });
});

const lines = (from: number, to: number) =>
  Array.from({ length: to - from + 1 }, (_, i) => `out-line-${from + i}`);
const stdoutCall = (stdout: string): CallSpec => ({
  id: "tail-1",
  tool: "Bash",
  input: { command: "printf tail-check" },
  output: { stdout, stderr: "" },
  durationMs: 5,
});
const tailPre = (el: Element) =>
  Array.from(el.querySelectorAll("pre")).find((pre) => pre.textContent?.includes("out-line-"));

describe("F: Bash collapsed tail is exactly the last 10 lines", () => {
  it("shows the last 10 lines of a 25 line output, and Expand output shows all 25", async () => {
    await renderPlain([stdoutCall(lines(1, 25).join("\n"))]);
    await expect.element(articles()).toMatchTextContent("out-line-25");
    const card = articles().element();
    expect(tailPre(card)?.textContent).toBe(lines(16, 25).join("\n"));
    await articles()
      .getByRole("button", { name: /expand output/i })
      .click();
    expect(tailPre(card)?.textContent?.split("\n").filter(Boolean)).toEqual(lines(1, 25));
  });

  it("a trailing newline does not cost a line", async () => {
    await renderPlain([stdoutCall(`${lines(1, 25).join("\n")}\n`)]);
    await expect.element(articles()).toMatchTextContent("out-line-25");
    const card = articles().element();
    const shown = tailPre(card)?.textContent ?? "";
    expect(shown.replace(/\n$/, "")).toBe(lines(16, 25).join("\n"));
    expect(shown).not.toContain("out-line-15\n");
    await articles()
      .getByRole("button", { name: /expand output/i })
      .click();
    expect(tailPre(card)?.textContent?.split("\n").filter(Boolean)).toEqual(lines(1, 25));
  });

  it("shows an output of 10 lines or fewer whole, with or without a trailing newline", async () => {
    await renderPlain([stdoutCall(`${lines(1, 10).join("\n")}\n`)]);
    await expect.element(articles()).toMatchTextContent("out-line-10");
    const shown = tailPre(articles().element())?.textContent ?? "";
    expect(shown.replace(/\n$/, "")).toBe(lines(1, 10).join("\n"));
  });
});
