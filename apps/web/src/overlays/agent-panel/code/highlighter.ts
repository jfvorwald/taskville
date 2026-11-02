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

/** The app-wide highlighter. Shiki is a separate chunk, fetched on the first expanded card. */
export const sharedHighlighter: CodeHighlighter = createCodeHighlighter(async () =>
  (await import("./shikiBackend.ts")).createShikiBackend(),
);
