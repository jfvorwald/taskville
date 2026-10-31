// JSONL files (contracts/events.md): one input event per line, UTF-8; blank lines and lines
// starting with `//` are ignored; line numbers are reported with rejections.

export type JsonlLine =
  | { line: number; ok: true; value: unknown }
  | { line: number; ok: false; error: string };

export function parseJsonl(text: string): JsonlLine[] {
  const entries: JsonlLine[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const trimmed = raw.trim();
    if (trimmed === "" || trimmed.startsWith("//")) return;
    try {
      entries.push({ line: index + 1, ok: true, value: JSON.parse(trimmed) });
    } catch (error) {
      entries.push({ line: index + 1, ok: false, error: (error as Error).message });
    }
  });
  return entries;
}

/** Splits items into batches of at most `maxItems` and about `maxBytes` of JSON each. */
export function batches<T extends { value: unknown }>(
  items: readonly T[],
  maxItems: number,
  maxBytes: number,
): T[][] {
  const out: T[][] = [];
  let current: T[] = [];
  let bytes = 0;
  for (const item of items) {
    const size = Buffer.byteLength(JSON.stringify(item.value)) + 1;
    if (current.length > 0 && (current.length >= maxItems || bytes + size > maxBytes)) {
      out.push(current);
      current = [];
      bytes = 0;
    }
    current.push(item);
    bytes += size;
  }
  if (current.length > 0) out.push(current);
  return out;
}
