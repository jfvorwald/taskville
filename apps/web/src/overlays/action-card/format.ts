/** How long a request has waited, as a short whole-second label: `45s`, `2m 5s`, `1h 2m`. */
export function formatWaiting(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/**
 * Controls, format characters, the contract's explicit invisible extras and the remaining
 * default-ignorable code points.
 */
const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\u034f|\u3164|\uffa0|[\ufe00-\ufe0f]|[\u{e0000}-\u{e007f}]|[\u115f\u1160]|[\u17b4\u17b5]|[\u180b-\u180d]|\u180f|[\u{e0100}-\u{e01ef}]/u;

/** Non-ASCII spaces: marked on the card, but real characters of a path, so kept when copying. */
const NON_ASCII_SPACE = /[\u00a0\u1680\u2000-\u200a\u202f\u205f\u3000\u2800]/u;

function isInvisible(char: string): boolean {
  return char !== "\t" && char !== "\n" && HIDDEN.test(char);
}

function isHidden(char: string): boolean {
  return isInvisible(char) || NON_ASCII_SPACE.test(char);
}

/**
 * Shows the characters that hide or reorder text as a visible `<U+XXXX>` marker. Applied to every
 * string an agent supplies before the card shows it. Newline and tab stay as they are.
 */
export function visibleControls(text: string): string {
  return Array.from(text, (char) => {
    if (!isHidden(char)) return char;
    const code = char.codePointAt(0) as number;
    return `<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
  }).join("");
}

/**
 * `text` on one line, with every control and invisible character (newline and tab too) removed.
 * Non-ASCII spaces stay: they can be part of a real path, and the copied text is quoted.
 */
export function stripControls(text: string): string {
  return Array.from(text)
    .filter((char) => !isInvisible(char) && char !== "\t" && char !== "\n")
    .join("");
}

/** `value` inside POSIX single quotes, so a shell reads it as one inert word. */
function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

/**
 * The clipboard text for a session that cannot be opened here. It is pasted into a terminal, so
 * each value has its controls stripped and is single-quoted, one line per value.
 */
export function copyOnlyText(args: { sessionId: string; cwd?: string | undefined }): string {
  const lines = [`session ${shellQuote(stripControls(args.sessionId))}`];
  if (args.cwd !== undefined) lines.push(`cwd ${shellQuote(stripControls(args.cwd))}`);
  return lines.join("\n");
}
