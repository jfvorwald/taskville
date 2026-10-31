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
 * document (the input is not changed) and, for each scalar that changed, its path
 * and spans. Everything under a sensitive property name (`password`, `apiKey`,
 * ...), at any depth, is masked entirely: strings, numbers, and booleans become
 * the mask marker, inside nested objects and arrays too, so `{ password: { value } }`
 * or `{ token: 123 }` never keeps its value (#194). Null carries nothing and stays.
 * Elsewhere a string that is a whole high-entropy token is masked entirely and any
 * other string is masked span by span. Property names pass through, and so do
 * numbers, booleans, and null outside a sensitive key.
 */
export function redactJson(value: JsonValue, options: RedactJsonOptions = {}): RedactedJson {
  const masks: JsonMask[] = [];
  const walk = (node: JsonValue, path: Array<string | number>, under: boolean): JsonValue => {
    if (typeof node === "string") {
      if (options.skip?.(path)) return node;
      const { text, spans } = redactString(node, under);
      if (spans.length > 0) masks.push({ path: [...path], spans });
      return text;
    }
    if (typeof node === "number" || typeof node === "boolean") {
      if (!under || options.skip?.(path)) return node;
      const marker = maskMarker("sensitive-value");
      const end = JSON.stringify(node).length;
      masks.push({
        path: [...path],
        spans: [
          { kind: "sensitive-value", start: 0, end, maskedStart: 0, maskedEnd: marker.length },
        ],
      });
      return marker;
    }
    // Array items inherit their parent's sensitivity, so `{ password: ["x"] }` masks "x".
    if (Array.isArray(node)) return node.map((item, i) => walk(item, [...path, i], under));
    if (node !== null && typeof node === "object") {
      const out: { [key: string]: JsonValue } = {};
      for (const [k, v] of Object.entries(node)) {
        // defineProperty, not assignment, so a "__proto__" key from parsed JSON stays
        // an own property instead of replacing the output's prototype.
        Object.defineProperty(out, k, {
          value: walk(v, [...path, k], under || isSensitiveName(k)),
          enumerable: true,
          writable: true,
          configurable: true,
        });
      }
      return out;
    }
    return node;
  };
  return { value: walk(value, [], false), masks };
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
