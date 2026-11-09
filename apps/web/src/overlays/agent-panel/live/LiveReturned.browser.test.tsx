import { describe, expect, it } from "vitest";
import { type Locator, page } from "vitest/browser";
import { type CallSpec, renderConstrained } from "./liveKit.tsx";

// A1.00: a tool call that finished with phase `returned` (it came back, the outcome was not
// reported) reads as Returned. It never claims success and is not opened as a failure
// (constitution IV).

const entries = () => page.getByTestId("logbook-entry");
const part = (entry: Locator, id: string) => entry.getByTestId(id);
const sentenceOf = (entry: Locator) => part(entry, "entry-sentence").element().textContent?.trim();
const expandedOf = (entry: Locator) =>
  entry
    .getByRole("button", { name: /^details\b/i })
    .element()
    .getAttribute("aria-expanded");
const glyphOf = (entry: Locator) =>
  part(entry, "entry-status").element().querySelector("[data-glyph]")?.getAttribute("data-glyph");

const returned = (spec: CallSpec): CallSpec =>
  ({ ...spec, phase: "returned" }) as unknown as CallSpec;

async function show(specs: readonly CallSpec[]) {
  await renderConstrained(specs, 1200);
  await expect.poll(() => entries().elements().length).toBeGreaterThan(0);
}

describe("A1.00 a returned call in the logbook", () => {
  it("shows state text Returned and data-state returned", async () => {
    await show([returned({ id: "r-state", tool: "Bash", input: { command: "make" } })]);
    const status = part(entries(), "entry-status").element();
    expect(status.textContent).toMatch(/Returned/);
    expect(status.getAttribute("data-state")).toBe("returned");
    expect(status.textContent).not.toMatch(/Succeeded|Failed|Running|Unfinished/);
  });

  it("uses a glyph distinct from succeeded, failed and running", async () => {
    await show([
      returned({ id: "g-returned", tool: "Bash", input: { command: "echo returned" } }),
      { id: "g-ok", tool: "Bash", input: { command: "echo ok" } },
      { id: "g-bad", tool: "Bash", input: { command: "echo bad" }, phase: "failed" },
      { id: "g-run", tool: "Bash", input: { command: "echo run" }, phase: "running" },
    ]);
    const glyph = (text: string) => glyphOf(entries().filter({ hasText: text }));
    const own = glyph("echo returned");
    expect(own).toBeTruthy();
    for (const other of ["echo ok", "echo bad", "echo run"]) {
      expect(own).not.toBe(glyph(other));
    }
  });

  it.each([
    [
      "Bash",
      { id: "s-bash", tool: "Bash", input: { command: "git status --short\nsecond" } },
      "Ran git status --short",
    ],
    [
      "Edit",
      {
        id: "s-edit",
        tool: "Edit",
        input: { file_path: "/r/src/notes.ts", old_string: "OLD", new_string: "N1\nN2\nN3" },
        filePaths: ["/r/src/notes.ts"],
      },
      "Edit returned: notes.ts",
    ],
    [
      "Write",
      {
        id: "s-write",
        tool: "Write",
        input: { file_path: "/r/docs/hello.txt", content: "body" },
        filePaths: ["/r/docs/hello.txt"],
      },
      "Write returned: hello.txt",
    ],
    [
      "Read",
      {
        id: "s-read",
        tool: "Read",
        input: { file_path: "/r/docs/readme.md" },
        filePaths: ["/r/docs/readme.md"],
      },
      "Read returned: readme.md",
    ],
    ["Grep", { id: "s-grep", tool: "Grep", input: { pattern: "x" } }, "Grep returned"],
    [
      "WebFetch",
      { id: "s-web", tool: "WebFetch", input: { url: "https://a.io/x" } },
      "WebFetch returned",
    ],
  ] as const)("reads a returned %s as %s", async (_tool, spec, sentence) => {
    await show([returned(spec as CallSpec)]);
    expect(sentenceOf(entries())).toBe(sentence);
  });

  it("gives a returned Edit no counts and no claim of success", async () => {
    await show([
      returned({
        id: "e-counts",
        tool: "Edit",
        input: { file_path: "/r/src/a.ts", old_string: "OLD", new_string: "N1\nN2" },
        filePaths: ["/r/src/a.ts"],
      }),
    ]);
    const text = sentenceOf(entries()) ?? "";
    expect(text).not.toMatch(/[+−]\d/);
    expect(text).not.toMatch(/Edited/);
  });

  it("does not open a returned call by default as a failure", async () => {
    await show([
      returned({ id: "o-1", tool: "Bash", input: { command: "echo first" } }),
      returned({ id: "o-2", tool: "Bash", input: { command: "echo last" } }),
    ]);
    expect(expandedOf(entries().filter({ hasText: "echo first" }))).toBe("false");
    expect(expandedOf(entries().filter({ hasText: "echo last" }))).toBe("false");
  });

  it("keeps opening the newest failed entry, with returned calls after it left closed", async () => {
    await show([
      {
        id: "f-1",
        tool: "Bash",
        input: { command: "echo bad" },
        phase: "failed",
        output: { stdout: "", stderr: "boom\nmore" },
      },
      returned({ id: "f-2", tool: "Bash", input: { command: "echo after" } }),
    ]);
    expect(expandedOf(entries().filter({ hasText: "echo bad" }))).toBe("true");
    expect(expandedOf(entries().filter({ hasText: "echo after" }))).toBe("false");
  });
});
