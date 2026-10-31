import { describe, expect, it } from "vitest";
import { mergeWrittenSections } from "../src/sections.ts";
import { renderTemplate } from "../src/template.ts";

describe("renderTemplate", () => {
  it("fills variables", () => {
    expect(renderTemplate("a {{x}} b {{y}}", { x: "1", y: 2 })).toBe("a 1 b 2");
  });

  it("repeats a section for each item, with nested sections and parent lookups", () => {
    const template =
      "{{#lanes}}\nsection {{lane}}\n{{#tickets}}\n  {{key}} in {{lane}}\n{{/tickets}}\n{{/lanes}}\nend";
    const view = {
      lanes: [
        { lane: "A", tickets: [{ key: "T1" }, { key: "T2" }] },
        { lane: "B", tickets: [{ key: "T3" }] },
      ],
    };
    expect(renderTemplate(template, view)).toBe(
      "section A\n  T1 in A\n  T2 in A\nsection B\n  T3 in B\nend",
    );
  });

  it("drops lines holding only a section tag, keeping their indentation out", () => {
    expect(
      renderTemplate("x\n  {{#items}}\n  - {{.}}\n  {{/items}}\ny", { items: ["a", "b"] }),
    ).toBe("x\n  - a\n  - b\ny");
  });

  it("renders nothing for an empty or false section", () => {
    expect(renderTemplate("a\n{{#items}}\n- x\n{{/items}}\nb", { items: [] })).toBe("a\nb");
    expect(renderTemplate("a{{#flag}}!{{/flag}}", { flag: false })).toBe("a");
  });

  it("fails on a variable the view does not define, so nothing renders blank", () => {
    expect(() => renderTemplate("{{missing}}", {})).toThrow(/missing/);
  });

  it("fails on an unclosed section", () => {
    expect(() => renderTemplate("{{#a}}x", { a: [1] })).toThrow(/a/);
  });
});

describe("mergeWrittenSections", () => {
  const generated = [
    "# Retro: M1",
    "",
    "## At a glance",
    "",
    "new numbers",
    "",
    "## What went well *(written)*",
    "",
    "## What hurt *(written)*",
    "",
    "Prompt text from the template.",
    "",
  ].join("\n");

  it("returns the generated report when there is no earlier one", () => {
    expect(mergeWrittenSections(generated, undefined)).toBe(generated);
  });

  it("keeps the lead's written sections and regenerates the rest", () => {
    const existing = [
      "# Retro: M1",
      "",
      "## At a glance",
      "",
      "old numbers",
      "",
      "## What went well *(written)*",
      "",
      "Parallel lanes worked.",
      "",
      "## What hurt *(written)*",
      "",
      "Rebases.",
      "",
    ].join("\n");
    const merged = mergeWrittenSections(generated, existing);
    expect(merged).toContain("new numbers");
    expect(merged).not.toContain("old numbers");
    expect(merged).toContain("## What went well *(written)*\n\nParallel lanes worked.\n");
    expect(merged).toContain("## What hurt *(written)*\n\nRebases.\n");
    expect(merged).not.toContain("Prompt text from the template.");
  });

  it("keeps the template text of a written section the lead has not filled in", () => {
    const existing = "# Retro: M1\n\n## At a glance\n\nold\n";
    expect(mergeWrittenSections(generated, existing)).toContain("Prompt text from the template.");
  });

  it("never drops a written section whose heading the template no longer has", () => {
    const existing = "# Retro: M1\n\n## Old notes *(written)*\n\nKeep me.\n";
    const merged = mergeWrittenSections(generated, existing);
    expect(merged).toContain("## Old notes *(written)*\n\nKeep me.");
  });
});
