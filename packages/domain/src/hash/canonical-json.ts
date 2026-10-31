// Canonical JSON: one exact text for one JSON value, so equal values hash equal.
// It is the basis for event content hashes (dedupe) and for stateHash, which must
// be byte-identical across replays (constitution III).
//
// The output follows RFC 8785 (JSON Canonicalization Scheme) for every input it
// accepts, and is stricter about what it accepts:
//
// 1. Objects: keys sorted by UTF-16 code unit order (plain `<` on strings, which
//    is what Array.prototype.sort does by default). Not code point order, not
//    locale order. No whitespace anywhere.
// 2. Only plain objects are accepted: prototype is null or an Object.prototype
//    (from any realm). Dates, Maps, Sets, class instances, typed arrays, boxed
//    primitives and the like are rejected rather than coerced, and toJSON is never
//    called. Objects with symbol keys are rejected. Only own enumerable string
//    keys are read; an own "__proto__" key is an ordinary key.
// 3. undefined: an object property whose value is undefined is omitted, so
//    `{ a: undefined }` and `{}` are the same value (as they are once stored as
//    JSON). undefined at the top level or as an array element is rejected.
// 4. Arrays: element order is preserved. Holes are rejected.
// 5. Numbers: finite only; NaN and the infinities are rejected. -0 is written as
//    0. Everything else is written as ECMAScript Number::toString does (shortest
//    round-trip form, for example 1e+21, 1e-7, 0.000001), as RFC 8785 specifies.
//    bigint is rejected.
// 6. Strings (values and keys): must be well-formed UTF-16; a lone surrogate is
//    rejected, because UTF-8 cannot represent it and replacing it would make two
//    strings equal. Escaped exactly as JSON.stringify escapes: `"` and `\` with a
//    backslash, U+0008/0009/000A/000C/000D as \b \t \n \f \r, other code units
//    below U+0020 as \u00xx in lowercase hex. Everything else, including non-ASCII
//    and U+2028/U+2029, is written as itself. No Unicode normalization: NFC and
//    NFD forms of the same text are different strings.
// 7. Functions, symbols and cycles are rejected. The same object may appear more
//    than once if it is not its own ancestor.
//
// Rejection throws CanonicalJsonError with a JSONPath-like `path` to the value.

/** Thrown when a value has no canonical JSON form. */
export class CanonicalJsonError extends Error {
  readonly path: string;

  constructor(path: string, problem: string) {
    super(`canonicalJson: ${problem} at ${path}`);
    this.name = "CanonicalJsonError";
    this.path = path;
  }
}

/** The canonical JSON text of `value`. Throws CanonicalJsonError if it has none. */
export function canonicalJson(value: unknown): string {
  const out: string[] = [];
  const path: (string | number)[] = [];
  const ancestors = new Set<object>();

  const fail = (problem: string): never => {
    throw new CanonicalJsonError(formatPath(path), problem);
  };

  const writeString = (s: string): void => {
    if (!s.isWellFormed()) fail("string contains a lone surrogate");
    out.push(JSON.stringify(s));
  };

  const write = (v: unknown): void => {
    switch (typeof v) {
      case "string":
        writeString(v);
        return;
      case "number":
        if (!Number.isFinite(v)) fail(`non-finite number ${String(v)}`);
        out.push(v === 0 ? "0" : String(v));
        return;
      case "boolean":
        out.push(v ? "true" : "false");
        return;
      case "undefined":
        fail("undefined is not a JSON value");
        return;
      case "object":
        break;
      default:
        fail(`${typeof v} is not a JSON value`);
    }
    if (v === null) {
      out.push("null");
      return;
    }
    const obj = v as object;
    if (ancestors.has(obj)) fail("cycle");
    ancestors.add(obj);
    if (Array.isArray(obj)) {
      out.push("[");
      for (let i = 0; i < obj.length; i++) {
        path.push(i);
        if (!(i in obj)) fail("array hole");
        if (i > 0) out.push(",");
        write(obj[i]);
        path.pop();
      }
      out.push("]");
    } else {
      if (!isPlainObject(obj)) fail(`non-plain object ${Object.prototype.toString.call(obj)}`);
      if (Object.getOwnPropertySymbols(obj).length > 0) fail("object has symbol keys");
      const record = obj as Record<string, unknown>;
      const keys = Object.keys(record).sort();
      out.push("{");
      let first = true;
      for (const key of keys) {
        const child = record[key];
        if (child === undefined) continue;
        path.push(key);
        if (!first) out.push(",");
        first = false;
        writeString(key);
        out.push(":");
        write(child);
        path.pop();
      }
      out.push("}");
    }
    ancestors.delete(obj);
  };

  write(value);
  return out.join("");
}

function isPlainObject(obj: object): boolean {
  const proto: unknown = Object.getPrototypeOf(obj);
  if (proto !== null && Object.getPrototypeOf(proto) !== null) return false;
  return Object.prototype.toString.call(obj) === "[object Object]";
}

function formatPath(path: readonly (string | number)[]): string {
  let s = "$";
  for (const part of path) {
    if (typeof part === "number") s += `[${part}]`;
    else if (/^[A-Za-z_$][\w$]*$/.test(part)) s += `.${part}`;
    // A lone surrogate in a key would make JSON.stringify escape it, which is fine here.
    else s += `[${JSON.stringify(part)}]`;
  }
  return s;
}
