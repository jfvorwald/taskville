import { useEffect, useMemo, useState } from "react";
import { redactText } from "../../../../../../packages/adapters/src/redact/text.ts";
import { visibleControls } from "../../action-card/format.ts";
import { type CodeHighlighter, type HighlightToken, sharedHighlighter } from "./highlighter.ts";

export interface CodeBodyProps {
  text: string;
  language: string;
  /** When on, the body is not shown and nothing is loaded or run. */
  privacy: boolean;
  highlighter?: CodeHighlighter;
}

/** No code body is tokenized or shown past this many characters. */
const CAP = 20_000;
/** Only a plain hex color is applied to a token. Anything else is ignored. */
const HEX_COLOR = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;

/** Masked first, then hidden and reordering characters shown as <U+XXXX>, then bounded. */
function sanitize(text: string) {
  const shown = visibleControls(redactText(text).text);
  return shown.length > CAP
    ? { text: shown.slice(0, CAP), truncated: true }
    : { text: shown, truncated: false };
}

/**
 * Code as inert text in a <pre>: React text nodes only, never HTML or Markdown. Secrets are masked
 * before the highlighter sees the text. Highlight colors are applied only when they are plain hex.
 */
export function CodeBody({
  text,
  language,
  privacy,
  highlighter = sharedHighlighter,
}: CodeBodyProps) {
  const safe = useMemo(() => sanitize(text), [text]);
  const [tokens, setTokens] = useState<{ source: string; lines: HighlightToken[][] }>();

  useEffect(() => {
    if (privacy) return;
    let current = true;
    void highlighter.highlight(safe.text, language).then((lines) => {
      if (current) setTokens({ source: safe.text, lines });
    });
    return () => {
      current = false;
    };
  }, [privacy, highlighter, safe.text, language]);

  if (privacy) return <p>Code hidden by the privacy setting</p>;

  const lines = tokens?.source === safe.text ? tokens.lines : undefined;
  return (
    <>
      <pre>
        {lines
          ? lines.map((line, row) => (
              // biome-ignore lint/suspicious/noArrayIndexKey: lines have no identity; the list is replaced whole.
              <span key={row}>
                {line.map((token, col) => (
                  <span
                    // biome-ignore lint/suspicious/noArrayIndexKey: tokens have no identity either.
                    key={col}
                    style={
                      token.color && HEX_COLOR.test(token.color)
                        ? { color: token.color }
                        : undefined
                    }
                  >
                    {token.content}
                  </span>
                ))}
                {row < lines.length - 1 ? "\n" : null}
              </span>
            ))
          : safe.text}
      </pre>
      {safe.truncated ? <p>Display truncated at 20,000 characters</p> : null}
    </>
  );
}
