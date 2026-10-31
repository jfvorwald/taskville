import { createHash } from "node:crypto";
import { type JsonValue, maskMarker, redactJson, redactText } from "@taskville/adapters/redact";

/** ARCHITECTURE.md 7.4: each stored body is at most 64 KB (65,536 UTF-8 bytes). */
export const MAX_BODY_BYTES = 64 * 1024;
/** Ends every body that was cut; counted inside the 64 KB. */
export const TRUNCATION_MARKER = "\n[truncated by Taskville: the body was over 64 KB]";

export interface PreparedBody {
  /** What is stored: masked, well-formed, cut to 64 KB. */
  text: string;
  /** UTF-8 byte length of `text`. */
  bytes: number;
  /** SHA-256 (hex) of `text`'s UTF-8 bytes: the stored bytes, never the raw ones. */
  hash: string;
  truncated: boolean;
  /** Whether the redactor masked anything. */
  masked: boolean;
}

/**
 * Turns a raw tool input or output (agent-supplied, untrusted, unmasked) into
 * the only form that may be written. Order matters:
 *
 * 1. Serialize: a string is kept as is. Anything else first has every value
 *    under a sensitive key (`password`, `apiKey`, ...) replaced whole by the
 *    mask marker, whatever its type: `redactJson` masks only strings directly
 *    under such a key, so `{ password: { value } }` or `{ token: 123 }` would
 *    pass. Then every string is masked with `redactJson`, and the result is
 *    written as compact JSON.
 * 2. Make it well-formed (a lone surrogate becomes U+FFFD), so the hash covers
 *    exactly the bytes SQLite stores.
 * 3. Mask the whole serialized text with `redactText`. The full body is masked
 *    before any cut: cutting first could split a secret (or a private key
 *    block) so that the redactor no longer recognizes the half that is kept.
 * 4. Cut to 64 KB after masking (a marker can be longer than its secret, L-32)
 *    on a character boundary, ending with `TRUNCATION_MARKER`.
 * 5. Hash the stored text.
 *
 * Throws on a value it cannot serialize (a BigInt, or nesting deep enough to
 * overflow the stack); the caller skips that body. Returns undefined for a
 * value with no JSON form (`undefined`).
 */
export function prepareBody(value: unknown): PreparedBody | undefined {
  let serialized: string;
  let masked = false;
  if (typeof value === "string") {
    serialized = value;
  } else {
    const sealed = { masked: false };
    const redacted = redactJson(maskSensitiveSubtrees(value as JsonValue, sealed));
    masked = sealed.masked || redacted.masks.length > 0;
    const json: string | undefined = JSON.stringify(redacted.value);
    if (typeof json !== "string") return undefined;
    serialized = json;
  }
  const scanned = redactText(serialized.toWellFormed());
  masked ||= scanned.spans.length > 0;
  let text = scanned.text;
  let bytes = Buffer.byteLength(text, "utf8");
  const truncated = bytes > MAX_BODY_BYTES;
  if (truncated) {
    text =
      cutUtf8(text, MAX_BODY_BYTES - Buffer.byteLength(TRUNCATION_MARKER, "utf8")) +
      TRUNCATION_MARKER;
    bytes = Buffer.byteLength(text, "utf8");
  }
  const hash = createHash("sha256").update(text, "utf8").digest("hex");
  return { text, bytes, hash, truncated, masked };
}

const SENSITIVE_MARKER = maskMarker("sensitive-value");
// A value the redactor never treats as a placeholder, used to ask it whether a key is sensitive.
const PROBE = "probe-value";

/**
 * Whether the redaction module treats `key` as a sensitive name. Asked of
 * `redactJson` itself, so the rule stays the module's own (L-17: no second
 * list to drift from it).
 */
function isSensitiveKey(key: string, cache: Map<string, boolean>): boolean {
  let sensitive = cache.get(key);
  if (sensitive === undefined) {
    sensitive = redactJson({ [key]: PROBE }).masks.length > 0;
    cache.set(key, sensitive);
  }
  return sensitive;
}

/**
 * Replaces the whole value of every sensitive key (any type but null) with the
 * mask marker. Rebuilt with `defineProperty`, so a `__proto__` key stays data
 * (L-18). Deep nesting throws `RangeError`, which the caller treats as a body
 * it cannot store.
 */
function maskSensitiveSubtrees(value: JsonValue, sealed: { masked: boolean }): JsonValue {
  const cache = new Map<string, boolean>();
  const walk = (node: JsonValue): JsonValue => {
    if (Array.isArray(node)) return node.map(walk);
    if (node === null || typeof node !== "object") return node;
    const out: { [key: string]: JsonValue } = {};
    for (const [key, child] of Object.entries(node)) {
      const sensitive = child !== null && typeof child !== "string" && isSensitiveKey(key, cache);
      if (sensitive) sealed.masked = true;
      const next = sensitive ? SENSITIVE_MARKER : walk(child);
      Object.defineProperty(out, key, {
        value: next,
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    return out;
  };
  return walk(value);
}

/** The longest prefix of well-formed `text` whose UTF-8 encoding fits `maxBytes`, on a character boundary. */
function cutUtf8(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  let end = maxBytes;
  // Back off continuation bytes (10xxxxxx) so the cut lands before a character's first byte.
  while (end > 0 && ((buffer[end] ?? 0) & 0xc0) === 0x80) end--;
  return buffer.subarray(0, end).toString("utf8");
}
