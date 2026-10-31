// Keeps the lead's written sections when a retro is regenerated. A written section is a `## `
// heading containing "*(written)*"; everything from it to the next `## ` heading belongs to the
// lead. Generated sections are always replaced. A written section whose heading the template no
// longer has is appended, so re-running never loses written text.

const WRITTEN = "*(written)*";

type Section = { heading: string; body: string };

function split(markdown: string): { preamble: string; sections: Section[] } {
  const lines = markdown.split("\n");
  let preamble = "";
  const sections: Section[] = [];
  // CommonMark fences: a fence closes only with the same character, at least as long, and
  // nothing after it, so a ~~~ line inside a ``` block (or a shorter fence) does not close it.
  let fence: { char: string; length: number } | null = null;
  for (const line of lines) {
    const marker = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
    if (marker !== null) {
      const run = marker[1] ?? "";
      const char = run[0] ?? "";
      if (fence === null) fence = { char, length: run.length };
      else if (
        char === fence.char &&
        run.length >= fence.length &&
        (marker[2] ?? "").trim() === ""
      ) {
        fence = null;
      }
    }
    const inFence = fence !== null || marker !== null;
    const current = sections.at(-1);
    if (!inFence && line.startsWith("## ")) {
      sections.push({ heading: line, body: "" });
    } else if (current === undefined) {
      preamble += `${line}\n`;
    } else {
      current.body += `${line}\n`;
    }
  }
  return { preamble, sections };
}

const join = (preamble: string, sections: Section[]): string =>
  (preamble + sections.map((s) => `${s.heading}\n${s.body}`).join("")).replace(/\n$/, "");

export function mergeWrittenSections(generated: string, existing: string | undefined): string {
  if (existing === undefined) return generated;
  const fresh = split(generated);
  const old = new Map(
    split(existing)
      .sections.filter((s) => s.heading.includes(WRITTEN))
      .map((s) => [s.heading.trim(), s.body]),
  );
  const merged = fresh.sections.map((section) => {
    const key = section.heading.trim();
    const body = old.get(key);
    if (!section.heading.includes(WRITTEN) || body === undefined) return section;
    old.delete(key);
    return body.trim() === "" ? section : { heading: section.heading, body };
  });
  for (const [heading, body] of old) {
    if (body.trim() === "") continue;
    const previous = merged.at(-1);
    if (previous !== undefined && !previous.body.endsWith("\n\n")) previous.body += "\n";
    merged.push({ heading, body });
  }
  const out = join(fresh.preamble, merged);
  return generated.endsWith("\n") && !out.endsWith("\n") ? `${out}\n` : out;
}
