// The card hides what the engine's redactors would mask in the event log. They are pure with no
// Node-only imports, so they are called here by relative path, the way `data/domain.ts` reaches
// the shared packages, instead of copying their rules.
import { type JsonValue, redactJson } from "../../../../../packages/adapters/src/redact/json.ts";
import { redactText } from "../../../../../packages/adapters/src/redact/text.ts";

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

/**
 * The secret spans of an input as the card shows it. `redactText` reads the text; it cannot see
 * that `{ "password": { "value": "x" } }` seals a whole object under a sensitive name, which the
 * JSON redactor does. For a structured input shown as pretty JSON, each value the JSON redactor
 * masked in full is added as one span covering that whole value.
 */
export function inputMaskSpans(toolInput: unknown, text: string): MaskSpan[] {
  const spans = maskSpans(text);
  if (typeof toolInput !== "object" || toolInput === null) return spans;
  const ranges = valueRanges(toolInput as JsonValue, text);
  if (ranges === null) return spans;
  const wholes: MaskSpan[] = [];
  for (const { path, spans: masked } of redactJson(toolInput as JsonValue).masks) {
    const range = ranges.get(JSON.stringify(path));
    const first = masked[0];
    if (range === undefined || first === undefined) continue;
    // A value the JSON redactor masked from its first character to its last is sealed whole: an
    // object, array, number or boolean under a sensitive name, or a string such as the `value`
    // of a `name`/`value` pair whose two properties are not side by side. The text pass cannot
    // tell those apart from other text, so cover the displayed value (a string without its quotes).
    const node = path.reduce<unknown>(
      (at, key) => (at as Record<string | number, unknown>)[key],
      toolInput,
    );
    if (first.start !== 0) continue;
    if (typeof node !== "string") {
      wholes.push({ kind: first.kind, start: range[0], end: range[1] });
    } else if (first.end >= node.length && node.length > 0) {
      wholes.push({ kind: first.kind, start: range[0] + 1, end: range[1] - 1 });
    }
  }
  return merge([...spans, ...wholes]);
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
