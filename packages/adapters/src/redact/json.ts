import {
  isHighEntropyToken,
  isPlaceholder,
  isSensitiveName,
  type MaskKind,
  maskMarker,
} from "./rules.ts";
import { type MaskSpan, redactText } from "./text.ts";

export type JsonValue =
  | string
  | number
  | boolean
  | null
  | JsonValue[]
  | { [key: string]: JsonValue };

/** Location of a value inside a JSON document: property names and array indices. */
export type JsonPath = ReadonlyArray<string | number>;

/** The spans masked in one string of a JSON document. */
export interface JsonMask {
  path: JsonPath;
  spans: MaskSpan[];
}

export interface RedactedJson {
  value: JsonValue;
  masks: JsonMask[];
}

export interface RedactJsonOptions {
  /**
   * Paths left untouched, for fields whose schema type is an ID, an enum, or a
   * timestamp (contracts/events.md "Masking"). The caller knows the schema.
   */
  skip?: (path: JsonPath) => boolean;
}

/**
 * Masks every string value in a JSON document, at any depth. Returns a new
 * document (the input is not changed) and, for each value that changed, its path
 * and spans. The whole value of a sensitive property name (`password`, `apiKey`,
 * ...) is sealed: any string, number, boolean, object, or array there becomes one
 * mask marker, keys inside it included, so `{ password: { value } }`,
 * `{ token: 123 }`, or `{ password: { hunter2: true } }` keeps nothing (#194).
 * Null carries nothing and stays, and so does a placeholder string (`$NAME`,
 * `***`, empty) directly under the key. Elsewhere a string that is a whole
 * high-entropy token is masked entirely and any other string is masked span by
 * span. Property names outside sealed values pass through, and so do numbers,
 * booleans, and null.
 */
export function redactJson(value: JsonValue, options: RedactJsonOptions = {}): RedactedJson {
  const masks: JsonMask[] = [];
  const seal = (node: JsonValue, path: Array<string | number>): JsonValue => {
    const marker = maskMarker("sensitive-value");
    const end = typeof node === "string" ? node.length : JSON.stringify(node).length;
    masks.push({
      path: [...path],
      spans: [{ kind: "sensitive-value", start: 0, end, maskedStart: 0, maskedEnd: marker.length }],
    });
    return marker;
  };
  const walk = (node: JsonValue, path: Array<string | number>): JsonValue => {
    if (typeof node === "string") {
      if (options.skip?.(path)) return node;
      const { text, spans } = redactString(node, false);
      if (spans.length > 0) masks.push({ path: [...path], spans });
      return text;
    }
    if (Array.isArray(node)) return node.map((item, i) => walk(item, [...path, i]));
    if (node !== null && typeof node === "object") {
      const out: { [key: string]: JsonValue } = {};
      for (const [k, v] of Object.entries(node)) {
        const childPath = [...path, k];
        let next: JsonValue;
        if (!isSensitiveName(k) || v === null || options.skip?.(childPath)) {
          next = walk(v, childPath);
        } else if (typeof v === "string") {
          const { text, spans } = redactString(v, true);
          if (spans.length > 0) masks.push({ path: childPath, spans });
          next = text;
        } else {
          next = seal(v, childPath);
        }
        // defineProperty, not assignment, so a "__proto__" key from parsed JSON stays
        // an own property instead of replacing the output's prototype.
        Object.defineProperty(out, k, {
          value: next,
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return node;
  };
  return { value: walk(value, []), masks };
}

function redactString(value: string, sensitive: boolean): { text: string; spans: MaskSpan[] } {
  let whole: MaskKind | null = null;
  if (sensitive && !isPlaceholder(value, 0, value.length)) {
    whole = "sensitive-value";
  } else {
    const inner = redactText(value);
    if (inner.spans.length > 0 || !isHighEntropyToken(value)) return inner;
    whole = "high-entropy";
  }
  const marker = maskMarker(whole);
  return {
    text: marker,
    spans: [{ kind: whole, start: 0, end: value.length, maskedStart: 0, maskedEnd: marker.length }],
  };
}
