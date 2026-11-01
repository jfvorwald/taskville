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
 * True for the characters that hide or reorder what is read: C0 and C1 controls (but not tab and
 * newline), bidi formatting, zero-width characters and the byte order mark.
 */
function isHidden(code: number): boolean {
  return (
    (code <= 0x1f && code !== 0x09 && code !== 0x0a) ||
    (code >= 0x7f && code <= 0x9f) ||
    code === 0x061c ||
    (code >= 0x200b && code <= 0x200f) ||
    (code >= 0x202a && code <= 0x202e) ||
    code === 0x2060 ||
    (code >= 0x2066 && code <= 0x2069) ||
    code === 0xfeff
  );
}

/**
 * Shows the characters that hide or reorder text as a visible `<U+XXXX>` marker. Applied to every
 * string an agent supplies before the card shows it. Newline and tab stay as they are.
 */
export function visibleControls(text: string): string {
  let out = "";
  let from = 0;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isHidden(code)) continue;
    out += `${text.slice(from, i)}<U+${code.toString(16).toUpperCase().padStart(4, "0")}>`;
    from = i + 1;
  }
  return from === 0 ? text : out + text.slice(from);
}

/** `text` on one line, with every control and invisible character (newline and tab too) removed. */
export function stripControls(text: string): string {
  let out = "";
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (!isHidden(code) && code !== 0x09 && code !== 0x0a) out += text[i];
  }
  return out;
}
