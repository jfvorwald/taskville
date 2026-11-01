/** How long a request has waited, as a short whole-second label: `45s`, `2m 5s`, `1h 2m`. */
export function formatWaiting(ms: number): string {
  if (!Number.isFinite(ms) || ms < 0) return "0s";
  const seconds = Math.floor(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  return `${Math.floor(minutes / 60)}h ${minutes % 60}m`;
}

/** Controls, format characters and the contract's explicit invisible extras. */
const HIDDEN =
  /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]|\u034f|\u3164|\uffa0|[\ufe00-\ufe0f]|[\u{e0000}-\u{e007f}]/u;

function isHidden(char: string): boolean {
  return char !== "\t" && char !== "\n" && HIDDEN.test(char);
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

/** `text` on one line, with every control and invisible character (newline and tab too) removed. */
export function stripControls(text: string): string {
  return Array.from(text)
    .filter((char) => !isHidden(char) && char !== "\t" && char !== "\n")
    .join("");
}
