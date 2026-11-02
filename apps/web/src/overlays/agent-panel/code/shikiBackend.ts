import { createHighlighterCore } from "shiki/core";
import { createJavaScriptRegexEngine } from "shiki/engine/javascript";
import { bundledLanguages } from "shiki/langs";
import { bundledThemes } from "shiki/themes";
import type { HighlightBackend } from "./highlighter.ts";

const THEME = "github-dark";

/**
 * Shiki with the JavaScript regex engine (no WASM). Each language is its own chunk, imported the
 * first time a card in that language is highlighted. Only this file imports shiki, and only
 * highlighter.ts imports this file, dynamically.
 */
export async function createShikiBackend(): Promise<HighlightBackend> {
  const shiki = await createHighlighterCore({
    themes: [bundledThemes[THEME]],
    langs: [],
    engine: createJavaScriptRegexEngine(),
  });
  return {
    async tokenize(text, language) {
      const key = language.toLowerCase();
      if (!Object.hasOwn(bundledLanguages, key)) throw new Error(`unknown language ${language}`);
      const loader = bundledLanguages[key as keyof typeof bundledLanguages];
      if (!shiki.getLoadedLanguages().includes(key)) await shiki.loadLanguage(loader);
      const lines = shiki.codeToTokensBase(text, { lang: key, theme: THEME });
      return lines.map((line) =>
        line.map((token) =>
          token.color === undefined
            ? { content: token.content }
            : { content: token.content, color: token.color },
        ),
      );
    },
  };
}
