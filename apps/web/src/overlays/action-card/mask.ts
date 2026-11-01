// The card hides what the engine's redactors would mask in the event log. They are pure with no
// Node-only imports, so they are called here by relative path, the way `data/domain.ts` reaches
// the shared packages, instead of copying their rules.
import { type JsonValue, redactJson } from "../../../../../packages/adapters/src/redact/json.ts";
import { redactText } from "../../../../../packages/adapters/src/redact/text.ts";
import { visibleControls } from "./format.ts";

/** A secret-looking part of an input: UTF-16 offsets into the text, half-open. */
export interface MaskSpan {
  kind: string;
  start: number;
  end: number;
}

/** The secret spans of `text`, sorted and never overlapping. */
export function maskSpans(text: string): MaskSpan[] {
  return redactText(text).spans.map(({ kind, start, end }) => ({ kind, start, end }));
}

/**
 * Where each value of `value` sits in its two-space pretty JSON, by path. Null when the layout
 * does not reproduce `text` exactly, so a range is never trusted on a guess.
 */
function valueRanges(value: JsonValue, text: string): Map<string, [number, number]> | null {
  const ranges = new Map<string, [number, number]>();
  let out = "";
  const pad = (depth: number) => "  ".repeat(depth);
  const walk = (node: JsonValue, path: Array<string | number>, depth: number) => {
    const start = out.length;
    if (Array.isArray(node) && node.length > 0) {
      out += "[\n";
      node.forEach((item, i) => {
        out += pad(depth + 1);
        walk(item, [...path, i], depth + 1);
        out += i < node.length - 1 ? ",\n" : "\n";
      });
      out += `${pad(depth)}]`;
    } else if (node !== null && typeof node === "object" && !Array.isArray(node)) {
      const entries = Object.entries(node);
      if (entries.length === 0) out += "{}";
      else {
        out += "{\n";
        entries.forEach(([key, child], i) => {
          out += `${pad(depth + 1)}${JSON.stringify(key)}: `;
          walk(child, [...path, key], depth + 1);
          out += i < entries.length - 1 ? ",\n" : "\n";
        });
        out += `${pad(depth)}}`;
      }
    } else out += JSON.stringify(node);
    ranges.set(JSON.stringify(path), [start, out.length]);
  };
  walk(value, [], 0);
  return out === text ? ranges : null;
}

/** The whole input as one span, for when nothing finer can be trusted. */
const wholeInput = (text: string): MaskSpan => ({
  kind: "sensitive-value",
  start: 0,
  end: text.length,
});

/** A string as JSON writes it inside its quotes. */
const escaped = (s: string) => JSON.stringify(s).slice(1, -1);

/** True for `{ command }` alone, which the card shows as the command itself. */
function isCommandOnly(toolInput: unknown, text: string): boolean {
  if (typeof toolInput !== "object" || toolInput === null || Array.isArray(toolInput)) return false;
  const keys = Object.keys(toolInput);
  return (
    keys.length === 1 &&
    keys[0] === "command" &&
    (toolInput as { command?: unknown }).command === text
  );
}

/**
 * The secret spans of an input as the card shows it (`text` is `inputText(toolInput)`).
 *
 * `redactText` reads the text. For a structured input shown as pretty JSON that is not enough: a
 * newline in a string is shown as backslash and n, which hides the start of a line from it, and
 * it cannot see that `{ "password": { "value": "x" } }` seals a whole object under a sensitive
 * name. The JSON redactor reads the real values, so each string span and each sealed value it
 * masks is mapped to its place in the displayed text and added. When the displayed layout cannot
 * be mapped and the JSON redactor found something, the whole input is one span: fail closed.
 */
export function inputMaskSpans(toolInput: unknown, text: string): MaskSpan[] {
  const spans = maskSpans(text);
  if (typeof toolInput !== "object" || toolInput === null) return spans;
  const json = toolInput as JsonValue;
  const masks = redactJson(json).masks;
  if (masks.length === 0) return spans;

  const found: MaskSpan[] = [];
  if (isCommandOnly(toolInput, text)) {
    // Shown as the command itself, so the offsets in the string are the offsets in the text.
    for (const { spans: inString } of masks) {
      for (const s of inString) found.push({ kind: s.kind, start: s.start, end: s.end });
    }
    return merge([...spans, ...found]);
  }

  const ranges = valueRanges(json, text);
  if (ranges === null) return [wholeInput(text)];
  for (const { path, spans: masked } of masks) {
    const range = ranges.get(JSON.stringify(path));
    const first = masked[0];
    if (range === undefined || first === undefined) return [wholeInput(text)];
    const node = path.reduce<unknown>(
      (at, key) => (at as Record<string | number, unknown>)[key],
      toolInput,
    );
    if (typeof node !== "string") {
      // An object, array, number or boolean sealed whole under a sensitive name.
      if (first.start === 0) found.push({ kind: first.kind, start: range[0], end: range[1] });
      continue;
    }
    // A string: its displayed form is the escaped string between quotes, so each span's place is
    // the length of the escaped text before it.
    const base = range[0] + 1;
    if (text.slice(base, range[1] - 1) !== escaped(node)) {
      found.push({ kind: first.kind, start: base, end: range[1] - 1 });
      continue;
    }
    let cursor = 0;
    let shown = base;
    for (const s of masked) {
      shown += escaped(node.slice(cursor, s.start)).length;
      const start = shown;
      shown += escaped(node.slice(s.start, s.end)).length;
      found.push({ kind: s.kind, start, end: shown });
      cursor = s.end;
    }
  }
  return merge([...spans, ...found]);
}

/** Sorted spans with overlaps joined, the first kind winning. */
function merge(spans: MaskSpan[]): MaskSpan[] {
  const sorted = [...spans].sort((a, b) => a.start - b.start || b.end - a.end);
  const out: MaskSpan[] = [];
  for (const span of sorted) {
    const last = out[out.length - 1];
    if (last !== undefined && span.start < last.end) last.end = Math.max(last.end, span.end);
    else out.push({ ...span });
  }
  return out;
}

/**
 * `raw` with the invisible and reordering characters shown as `<U+XXXX>` markers, and the spans
 * moved to the same places in the result. Spans are found on the raw text, which is what the
 * engine redacts; only what the user sees changes.
 */
export function markControls(
  raw: string,
  spans: readonly MaskSpan[],
): { text: string; spans: MaskSpan[] } {
  let text = "";
  let cursor = 0;
  const moved: MaskSpan[] = [];
  for (const span of spans) {
    text += visibleControls(raw.slice(cursor, span.start));
    const start = text.length;
    text += visibleControls(raw.slice(span.start, span.end));
    moved.push({ kind: span.kind, start, end: text.length });
    cursor = span.end;
  }
  return { text: text + visibleControls(raw.slice(cursor)), spans: moved };
}
