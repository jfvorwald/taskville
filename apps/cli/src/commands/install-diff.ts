import { type JsonValue, redactJson, redactText } from "@taskville/adapters/redact";

// The settings diff `install` shows before it asks (#29). A plain line diff with three lines of
// context. Nothing secret in the settings file is printed, even as context: first every string
// (and every number under a sensitive key, #194) the JSON redactor masks (it also knows sensitive property names such as `DB_PASSWORD`,
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

interface Sensitive {
  strings: Set<string>;
  numbers: Set<number>;
}

/**
 * Values in `text` (a JSON document) that redaction would mask: strings by JSON path or content,
 * and numbers under a sensitive key (#194). Booleans are masked in stored data too but carry one
 * bit, so the diff leaves `true` and `false` readable.
 */
function sensitiveValues(text: string | undefined, into: Sensitive): void {
  if (text === undefined) return;
  let doc: JsonValue;
  try {
    doc = JSON.parse(text) as JsonValue;
  } catch {
    return;
  }
  for (const mask of redactJson(doc).masks) {
    let node: unknown = doc;
    for (const step of mask.path) {
      node =
        node !== null && typeof node === "object" && Object.hasOwn(node, step)
          ? (node as Record<string | number, unknown>)[step]
          : undefined;
    }
    if (typeof node === "string" && node !== "") into.strings.add(node);
    if (typeof node === "number") into.numbers.add(node);
  }
}

const STRING_LITERAL = /"(?:[^"\\]|\\.)*"/g;
const NUMBER = /-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?/g;

/**
 * Replaces every JSON string literal on the line whose decoded value is sensitive, however it is
 * spelled (escapes included), and every number outside string literals whose value is sensitive,
 * then runs the text redactor over the line.
 */
function maskLine(line: string, sensitive: Sensitive): string {
  let out = "";
  let last = 0;
  const numbers = (segment: string) =>
    sensitive.numbers.size === 0
      ? segment
      : segment.replace(NUMBER, (token) =>
          sensitive.numbers.has(Number(token)) ? "[REDACTED]" : token,
        );
  for (const match of line.matchAll(STRING_LITERAL)) {
    out += numbers(line.slice(last, match.index));
    let value: unknown;
    try {
      value = JSON.parse(match[0]);
    } catch {
      value = undefined;
    }
    out += typeof value === "string" && sensitive.strings.has(value) ? `"[REDACTED]"` : match[0];
    last = match.index + match[0].length;
  }
  out += numbers(line.slice(last));
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
  const sensitive: Sensitive = { strings: new Set(), numbers: new Set() };
  sensitiveValues(before, sensitive);
  sensitiveValues(after, sensitive);
  return `${out.map((line) => maskLine(line, sensitive)).join("\n")}\n`;
}
