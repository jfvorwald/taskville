// Classification helpers shared by the text and JSON redactors. All pure and
// deterministic: the same input always gives the same answer.

/** Every kind of value the redactor masks. */
export type MaskKind =
  | "private-key"
  | "anthropic-key"
  | "openai-key"
  | "github-token"
  | "aws-access-key"
  | "slack-token"
  | "stripe-key"
  | "jwt"
  | "url-password"
  | "bearer-token"
  | "basic-auth"
  | "sensitive-value"
  | "high-entropy";

/** Lower wins when two detections overlap and are merged into one span. */
export const PRIORITY: Readonly<Record<MaskKind, number>> = {
  "private-key": 0,
  "anthropic-key": 1,
  "openai-key": 2,
  "github-token": 2,
  "aws-access-key": 2,
  "slack-token": 2,
  "stripe-key": 2,
  jwt: 2,
  "url-password": 3,
  "bearer-token": 4,
  "basic-auth": 4,
  "sensitive-value": 5,
  "high-entropy": 6,
};

/** The fixed text that replaces a masked value of the given kind. */
export function maskMarker(kind: MaskKind): string {
  return `[REDACTED:${kind}]`;
}

/** True when `text.slice(start, end)` is exactly one mask marker. */
export function isWholeMarker(text: string, start: number, end: number): boolean {
  return end - start <= 64 && /^\[REDACTED:[a-z-]+\]$/.test(text.slice(start, end));
}

// A mask marker, or a complete reference to a secret held elsewhere: `$NAME`
// (environment style, upper case), `${...}`, `${{ ... }}`, or `$(...)`. Sticky, so it
// only matches at the given index; bounded, so it never scans far.
const REFERENCE =
  /\[REDACTED:[a-z-]+\]|\$(?:[A-Z_][A-Z0-9_]*(?![A-Za-z0-9_])|\{\{[^{}\r\n]{0,200}\}\}|\{[^{}\r\n]{0,200}\}|\([^()\r\n]{0,200}\))/y;

/** Length of a mask marker or complete reference starting at `at`, or 0. */
export function referenceLength(text: string, at: number): number {
  REFERENCE.lastIndex = at;
  return REFERENCE.exec(text)?.[0].length ?? 0;
}

const SECRET_WORDS = new Set([
  "token",
  "secret",
  "password",
  "passwd",
  "passphrase",
  "credential",
  "credentials",
  "apikey",
  "pat",
  "authorization",
]);

// A trailing "key" is sensitive only with one of these qualifiers in front, so
// lookup keys such as cacheKey, sortKey, or idempotencyKey stay readable.
const KEY_QUALIFIERS = new Set([
  "api",
  "private",
  "secret",
  "access",
  "client",
  "encryption",
  "signing",
  "master",
  "auth",
  "license",
  "subscription",
]);

/**
 * True for names whose value is a secret: `*_TOKEN`, `*_SECRET`, `*_PASSWORD`,
 * `apiKey`, `client_secret`, and so on. Judged by the last word of the name.
 * An all-uppercase environment-style name ending in `_KEY` is always sensitive.
 */
export function isSensitiveName(name: string): boolean {
  const words = name
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
  const last = words.at(-1);
  if (last === undefined) return false;
  if (SECRET_WORDS.has(last)) return true;
  if (last !== "key" || words.length < 2) return false;
  if (/^[A-Z0-9_]+$/.test(name)) return true;
  return KEY_QUALIFIERS.has(words.at(-2) ?? "");
}

/**
 * Values that name a secret elsewhere rather than being one: empty, all `*`, or
 * exactly one mask marker or reference (`$NAME`, `${...}`, `$(...)`) with nothing
 * after it. `$ecret123`, `${hunter2`, and `[REDACTED:x]hunter2` are literal values.
 */
export function isPlaceholder(text: string, start: number, end: number): boolean {
  if (end <= start) return true;
  const ref = referenceLength(text, start);
  if (ref > 0) return start + ref === end;
  for (let i = start; i < end; i++) {
    if (text.charCodeAt(i) !== 0x2a /* * */) return false;
  }
  return true;
}

/**
 * Loose check for an unquoted value after `name: ` or `name = `, where prose and
 * code are common: at least 6 characters, a letter and a digit, and none of the
 * punctuation that marks code, paths, or sentences.
 */
export function looksLikeCredential(value: string): boolean {
  return (
    value.length >= 6 &&
    value.length <= 256 &&
    /[A-Za-z]/.test(value) &&
    /[0-9]/.test(value) &&
    !/[.()[\]{}<>;,/\\]/.test(value)
  );
}

const IMAGE_PREFIXES = ["iVBORw0KGgo", "/9j/", "R0lGOD", "UklGR", "PHN2Zy"];

/**
 * True for a random-looking token: 20 to 256 characters of base64 or base64url,
 * upper and lower case and digits, Shannon entropy close to what random text of
 * that length reaches, and not mostly made of word-like runs (camelCase
 * identifiers; random base62 text stays under the 0.7 cutoff about 99% of the time).
 * Hex-only strings (Git SHAs), UUIDs, base64 images, integrity digests, and
 * path-like runs do not qualify.
 */
export function isHighEntropyToken(value: string): boolean {
  if (value.length < 20 || value.length > 256) return false;
  if (!/^[A-Za-z0-9+/=_-]+$/.test(value)) return false;
  if (!/[a-z]/.test(value) || !/[A-Z]/.test(value) || !/[0-9]/.test(value)) return false;
  if (IMAGE_PREFIXES.some((p) => value.startsWith(p))) return false;
  if (/^sha(?:1|256|384|512)-/.test(value)) return false; // Subresource Integrity digest
  if (isPathLike(value)) return false;
  if (/^(?:toolu|srvtoolu|msg|req)_/.test(value)) return false; // Claude Code and API IDs
  if (wordCoverage(value) >= 0.7) return false;
  return shannonEntropy(value) >= Math.min(0.85 * Math.log2(value.length), 4.5);
}

/** A run with slashes that starts with a plain lowercase directory name, like `assets/index-x1`. */
function isPathLike(value: string): boolean {
  const first = value.split("/").find((segment) => segment.length > 0) ?? "";
  return value.includes("/") && /^[a-z]{3,}$/.test(first);
}

function wordCoverage(value: string): number {
  let covered = 0;
  for (const match of value.matchAll(/[A-Z][a-z]{2,}|[a-z]{4,}/g)) covered += match[0].length;
  return covered / value.length;
}

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let bits = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    bits -= p * Math.log2(p);
  }
  return bits;
}
