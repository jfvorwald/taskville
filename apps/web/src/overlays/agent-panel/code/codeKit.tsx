import { vi } from "vitest";
import type { HighlightBackend } from "./highlighter.ts";

// Shared helpers for the M5.09 tests. Not a test file. Everything here is synthetic.
//
// INTENDED INTERFACE (what the green phase builds; paths relative to this directory):
//
//   editorLink.ts
//     DEFAULT_EDITOR_TEMPLATE = "vscode://file{path}"
//     buildEditorLink(path: string, opts?: { template?: string; line?: number }): string | null
//       Fixed template with one {path} placeholder; the absolute path is encoded per segment
//       (encodeURIComponent, "/" kept). Null for a relative path, a ".." segment, a NUL, a
//       template without {path}, or a scheme outside the editor allowlist.
//
//   highlighter.ts
//     HighlightBackend = { tokenize(text, language): Promise<{ content: string; color?: string }[][]> }
//     createCodeHighlighter(load: () => Promise<HighlightBackend>):
//       { highlight(text, language): Promise<Token[][]>; readonly loadCount: number }
//       `load` (the lazy Shiki import, JS regex engine) runs on the first highlight and once only.
//       The real backend lives in the same module family; tests inject a fake and never import shiki.
//
//   CodeBody.tsx      <CodeBody text language privacy highlighter /> text-only <pre>; secrets
//                     masked BEFORE tokenizing; privacy hides the body and never loads anything.
//   ExpandableCode.tsx <ExpandableCode label text language privacy highlighter path? editorTemplate? />
//                     collapsed by default; the first Expand loads the highlighter; shows an
//                     "Open in editor" link only when buildEditorLink returns a URL.
//
//   ../../../city/crew/file-screen/label.ts
//     fileScreenLabel(path: string | null | undefined): string   (see its test)

export const RLO = String.fromCodePoint(0x202e);
export const ZWSP = String.fromCodePoint(0x200b);

/** A backend that returns one token per line and records every call. */
export function fakeBackend(
  tokenize?: (text: string, language: string) => { content: string; color?: string }[][],
) {
  const calls: { text: string; language: string }[] = [];
  const backend: HighlightBackend = {
    tokenize: async (text, language) => {
      calls.push({ text, language });
      return tokenize
        ? tokenize(text, language)
        : text.split("\n").map((line) => [{ content: line }]);
    },
  };
  return { backend, calls };
}

export function lazyHighlighterParts(backend: HighlightBackend) {
  const load = vi.fn(async () => backend);
  return { load };
}
