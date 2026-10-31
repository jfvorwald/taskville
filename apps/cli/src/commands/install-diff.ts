import { type JsonValue, redactJson, redactText } from "@taskville/adapters/redact";

// The settings diff `install` shows before it asks (#29). A plain line diff with three lines of
// context. Nothing secret in the settings file is printed, even as context: first every string
// value the JSON redactor masks (it also knows sensitive property names such as `DB_PASSWORD`,
// whose value may sit on a later line) is replaced wherever it appears quoted, then every line
// goes through the text redactor as well (roborev 5200).

const CONTEXT = 3;

type Op = { kind: " " | "-" | "+"; line: string };

/** Longest-common-subsequence line diff. Settings files are small, so O(n*m) is fine. */
function diffLines(a: string[], b: string[]): Op[] {
  const n = a.length;
  const m = b.length;
  const lcs: number[][] = Array.from({ length: n + 1 }, () => new Array<number>(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      const row = lcs[i] as number[];
      row[j] =
        a[i] === b[j]
          ? ((lcs[i + 1] as number[])[j + 1] as number) + 1
          : Math.max((lcs[i + 1] as number[])[j] as number, row[j + 1] as number);
    }
  }
  const ops: Op[] = [];
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (a[i] === b[j]) {
      ops.push({ kind: " ", line: a[i] as string });
      i++;
      j++;
    } else if (((lcs[i + 1] as number[])[j] as number) >= ((lcs[i] as number[])[j + 1] as number)) {
      ops.push({ kind: "-", line: a[i] as string });
      i++;
    } else {
      ops.push({ kind: "+", line: b[j] as string });
      j++;
    }
  }
  while (i < n) ops.push({ kind: "-", line: a[i++] as string });
  while (j < m) ops.push({ kind: "+", line: b[j++] as string });
  return ops;
}

/** String values in `text` (a JSON document) that redaction would mask, by JSON path or content. */
function sensitiveValues(text: string | undefined): string[] {
  if (text === undefined) return [];
  let doc: JsonValue;
  try {
    doc = JSON.parse(text) as JsonValue;
  } catch {
    return [];
  }
  const values: string[] = [];
  for (const mask of redactJson(doc).masks) {
    let node: unknown = doc;
    for (const step of mask.path) {
      node =
        node !== null && typeof node === "object" && Object.hasOwn(node, step)
          ? (node as Record<string | number, unknown>)[step]
          : undefined;
    }
    if (typeof node === "string" && node !== "") values.push(node);
  }
  return values;
}

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;

/**
 * Replaces every JSON string literal on the line whose decoded value is sensitive, however it is
 * spelled (escapes included), then runs the text redactor over the line.
 */
function maskLine(line: string, sensitive: ReadonlySet<string>): string {
  const out = line.replace(STRING_LITERAL, (literal) => {
    let value: unknown;
    try {
      value = JSON.parse(literal);
    } catch {
      return literal;
    }
    return typeof value === "string" && sensitive.has(value) ? `"[REDACTED]"` : literal;
  });
  return redactText(out).text;
}

const lines = (text: string | undefined): string[] => {
  if (text === undefined || text === "") return [];
  const parts = text.split("\n");
  if (parts.at(-1) === "") parts.pop();
  return parts;
};

/**
 * A unified-style diff of `before` (undefined: the file does not exist) and `after` (undefined:
 * the file is removed), headed by `path`. Empty when nothing changes.
 */
export function settingsDiff(
  path: string,
  before: string | undefined,
  after: string | undefined,
): string {
  if (before === after) return "";
  const ops = diffLines(lines(before), lines(after));
  const keep = ops.map((_op, k) =>
    ops.slice(Math.max(0, k - CONTEXT), k + CONTEXT + 1).some((o) => o.kind !== " "),
  );
  const out = [
    `--- ${before === undefined ? "/dev/null" : path}`,
    `+++ ${after === undefined ? "/dev/null" : path}`,
  ];
  let gap = true;
  ops.forEach((op, k) => {
    if (!keep[k]) {
      gap = true;
      return;
    }
    if (gap) out.push("@@");
    gap = false;
    out.push(`${op.kind}${op.line}`);
  });
  const missingNewline = (text: string | undefined) =>
    text !== undefined && text !== "" && !text.endsWith("\n");
  if (missingNewline(before) || missingNewline(after))
    out.push("\\ (no newline at end of the original file)");
  const sensitive = new Set([...sensitiveValues(before), ...sensitiveValues(after)]);
  return `${out.map((line) => maskLine(line, sensitive)).join("\n")}\n`;
}
