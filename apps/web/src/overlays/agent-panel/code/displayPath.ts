/** Longest path shown whole under privacy; a longer one is cut in the middle to fit. */
const MAX_SHOWN = 200;
const HEAD = 100;
const TAIL = MAX_SHOWN - HEAD - 1;

/** A newline, a line or paragraph separator, a control character, or a format (bidi) character. */
const UNSAFE = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;

export const PATH_HIDDEN = "path hidden";

/**
 * How a recorded path is shown. A path is recorded text and can carry content, so under privacy
 * one with a newline or control character is replaced and a long one is middle-truncated.
 */
export function displayPath(path: string, { privacy }: { privacy: boolean }): string {
  if (!privacy) return path;
  if (UNSAFE.test(path)) return PATH_HIDDEN;
  const chars = Array.from(path);
  if (chars.length <= MAX_SHOWN) return path;
  return `${chars.slice(0, HEAD).join("")}…${chars.slice(-TAIL).join("")}`;
}
