import { isShikiLanguage } from "./languages.ts";

export interface HighlightToken {
  content: string;
  color?: string;
}

/** What turns text into tokens. The real one is Shiki (shikiBackend.ts); tests inject a fake. */
export interface HighlightBackend {
  tokenize(text: string, language: string): Promise<HighlightToken[][]>;
}

export interface CodeHighlighter {
  highlight(text: string, language: string): Promise<HighlightToken[][]>;
  /** How many times the backend was loaded. */
  readonly loadCount: number;
}

/** A body with a line longer than this is shown plain: minified text would stall the tokenizer. */
export const MAX_LINE = 2000;

const plainLines = (text: string): HighlightToken[][] =>
  text.split("\n").map((line) => [{ content: line }]);

/**
 * A highlighter that loads its backend on the first `highlight` call and once only, even for
 * concurrent calls. A failed load or tokenize falls back to plain lines; a failed load is retried
 * on the next call.
 */
export function createCodeHighlighter(load: () => Promise<HighlightBackend>): CodeHighlighter {
  let loading: Promise<HighlightBackend> | undefined;
  let loadCount = 0;
  return {
    get loadCount() {
      return loadCount;
    },
    async highlight(text, language) {
      if (text.split("\n").some((line) => line.length > MAX_LINE)) return plainLines(text);
      try {
        if (!loading) {
          loadCount += 1;
          loading = load();
        }
        const pending = loading;
        const backend = await pending.catch((error: unknown) => {
          if (loading === pending) loading = undefined;
          throw error;
        });
        return await backend.tokenize(text, language);
      } catch {
        return plainLines(text);
      }
    },
  };
}

const lazyShiki = createCodeHighlighter(async () =>
  (await import("./shikiBackend.ts")).createShikiBackend(),
);

/**
 * The app-wide highlighter. Shiki is a separate chunk, fetched on the first expanded card in a
 * language it has a grammar for; plain text, lock files and unknown extensions never fetch it.
 */
export const sharedHighlighter: CodeHighlighter = {
  get loadCount() {
    return lazyShiki.loadCount;
  },
  async highlight(text, language) {
    return isShikiLanguage(language) ? lazyShiki.highlight(text, language) : plainLines(text);
  },
};
