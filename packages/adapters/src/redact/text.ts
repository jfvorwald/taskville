import {
  isHighEntropyToken,
  isPlaceholder,
  isSensitiveName,
  isWholeMarker,
  looksLikeCredential,
  type MaskKind,
  maskMarker,
  PRIORITY,
  referenceLength,
} from "./rules.ts";

/**
 * One masked region. Offsets are UTF-16 code units (JavaScript string indices),
 * half-open. `start`/`end` locate the secret in the original input, so a viewer
 * holding the unredacted in-memory copy can reveal it; `maskedStart`/`maskedEnd`
 * locate its marker in the masked text. Spans are sorted and never overlap.
 */
export interface MaskSpan {
  kind: MaskKind;
  start: number;
  end: number;
  maskedStart: number;
  maskedEnd: number;
}

export interface RedactedText {
  text: string;
  spans: MaskSpan[];
}

interface Candidate {
  start: number;
  end: number;
  kind: MaskKind;
}

// Token formats. Each pattern starts with a lookbehind so a match can only begin
// at the start of a token, never inside one. That keeps every scan linear: a long
// run of token characters is tried from its first character only.
const TOKEN_PATTERNS: ReadonlyArray<{
  kind: MaskKind;
  pattern: RegExp;
  group?: number;
  /** Extra evidence the match must show, for patterns that also match prose. */
  accept?: (match: RegExpMatchArray) => boolean;
}> = [
  { kind: "anthropic-key", pattern: /(?<![A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}/dg },
  {
    kind: "openai-key",
    pattern: /(?<![A-Za-z0-9_-])sk-(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{20,}/dg,
  },
  { kind: "github-token", pattern: /(?<![A-Za-z0-9_])gh[pousr]_[A-Za-z0-9]{36,}/dg },
  { kind: "github-token", pattern: /(?<![A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}/dg },
  {
    kind: "aws-access-key",
    pattern: /(?<![A-Za-z0-9+/])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/dg,
  },
  { kind: "slack-token", pattern: /(?<![A-Za-z0-9-])(?:xox[abposre]|xapp)-[A-Za-z0-9-]{10,}/dg },
  { kind: "stripe-key", pattern: /(?<![A-Za-z0-9_])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/dg },
  {
    kind: "jwt",
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{5,}\.eyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]*/dg,
  },
  {
    kind: "url-password",
    pattern: /(?<![A-Za-z0-9+.-])[A-Za-z][A-Za-z0-9+.-]{0,31}:\/\/[^\s/?#@:]*:([^\s/?#@]+)@/dg,
    group: 1,
  },
  {
    kind: "bearer-token",
    pattern: /(?<![A-Za-z0-9])bearer[ \t]+([A-Za-z0-9._~+/-]{16,}=*)/dgi,
    group: 1,
  },
  {
    kind: "basic-auth",
    pattern: /(?<![A-Za-z0-9])authorization:[ \t]*basic[ \t]+([A-Za-z0-9+/]{8,}={0,2})/dgi,
    group: 1,
  },
  {
    // Any scheme (`Token`, `ApiKey`, `Negotiate`, `SSWS`, ...) in a header or
    // assignment, including `Proxy-Authorization`. Listed after the basic pattern so
    // a Basic credential keeps its own kind when the two overlap.
    kind: "bearer-token",
    pattern:
      /(?<![A-Za-z0-9_])authorization["']?[ \t]*[:=][ \t]*["']?([A-Za-z][A-Za-z0-9._-]{0,31})[ \t]+([A-Za-z0-9._~+/=:-]{8,})/dgi,
    group: 2,
    accept: isSchemeCredential,
  },
];

// Authorization schemes in use by HTTP APIs. After one of these, any run of 8+
// credential characters is masked, letters-only included.
const AUTH_SCHEMES = new Set([
  "aws4-hmac-sha256",
  "apikey",
  "api-key",
  "api_key",
  "basic",
  "bearer",
  "digest",
  "dpop",
  "gssapi",
  "hawk",
  "kerberos",
  "mac",
  "negotiate",
  "ntlm",
  "oauth",
  "sso-key",
  "ssws",
  "token",
]);

/**
 * Evidence that the word after `Authorization:` and a scheme is a credential and
 * not prose (`Authorization: handled internally`): a known scheme, or a value
 * with a digit, or 16+ characters with both upper and lower case.
 */
function isSchemeCredential(match: RegExpMatchArray): boolean {
  if (AUTH_SCHEMES.has((match[1] ?? "").toLowerCase())) return true;
  const value = match[2] ?? "";
  return /[0-9]/.test(value) || (value.length >= 16 && /[a-z]/.test(value) && /[A-Z]/.test(value));
}

const PEM_BEGIN = /-----BEGIN [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;
const PEM_END = /-----END [A-Z0-9 ]{0,40}PRIVATE KEY(?: BLOCK)?-----/g;

// `name=`, `name = `, `name: `, `"name": `, `'name': `. Only the name and separator
// are matched; the value is read by hand so a value that is not masked can still
// contain assignments that are (for example `URL=https://x/?token=...`).
const ASSIGNMENT =
  /(?<![A-Za-z0-9_.$-])(["']?)([A-Za-z_][A-Za-z0-9_.-]{0,99})\1([ \t]*)(=(?![=>~])|:(?![:/]))([ \t]*)/g;

// A standalone run of base64 or base64url characters (with at most two trailing
// "=" pads, so `NAME=value` is never one run), judged by isHighEntropyToken.
// The lookarounds pin it to a whole run, so a run is tried from its first character
// only and one longer than 256 fails after a bounded backtrack.
const STANDALONE = /(?<![A-Za-z0-9+/=_-])[A-Za-z0-9+/_-]{20,256}={0,2}(?![A-Za-z0-9+/=_-])/g;

// `--name=value` and `--name value` command-line flags.
const FLAG = /(?<![A-Za-z0-9_-])--([A-Za-z][A-Za-z0-9-]{0,63})(=|[ \t]+)/g;

// curl's `-u user:password` (also attached, `-uuser:password`), `--user user:password`,
// `--user=user:password`, and the proxy forms `-U` and `--proxy-user`.
const USER_FLAG = /(?<![A-Za-z0-9_-])(?:-[uU][ \t]*|--(?:proxy-)?user(?:=|[ \t]+))/g;

// The colon that ends the user name is looked for only this far, so a long run
// after a flag costs a bounded scan per match.
const MAX_USER = 128;

/** Masks secret-looking values in a string. Deterministic and idempotent. */
export function redactText(input: string): RedactedText {
  const candidates: Candidate[] = [];
  findPrivateKeys(input, candidates);
  findTokens(input, candidates);
  const ends = valueEnds(input);
  findAssignments(input, ends, candidates);
  findFlags(input, ends, candidates);
  findUserFlags(input, ends, candidates);
  findStandaloneTokens(input, candidates);
  return applyMasks(input, merge(candidates));
}

function findPrivateKeys(input: string, out: Candidate[]): void {
  PEM_BEGIN.lastIndex = 0;
  for (let begin = PEM_BEGIN.exec(input); begin !== null; begin = PEM_BEGIN.exec(input)) {
    PEM_END.lastIndex = PEM_BEGIN.lastIndex;
    const end = PEM_END.exec(input);
    // A block cut off before its END line is masked to the end of the text.
    const stop = end === null ? input.length : end.index + end[0].length;
    out.push({ start: begin.index, end: stop, kind: "private-key" });
    PEM_BEGIN.lastIndex = stop;
  }
}

function findTokens(input: string, out: Candidate[]): void {
  for (const { kind, pattern, group, accept } of TOKEN_PATTERNS) {
    for (const match of input.matchAll(pattern)) {
      const [start, end] = match.indices?.[group ?? 0] ?? [match.index, match.index];
      if (end <= start || isWholeMarker(input, start, end)) continue;
      if (accept !== undefined && !accept(match)) continue;
      out.push({ start, end, kind });
    }
  }
}

function findStandaloneTokens(input: string, out: Candidate[]): void {
  for (const match of input.matchAll(STANDALONE)) {
    if (isHighEntropyToken(match[0])) {
      out.push({ start: match.index, end: match.index + match[0].length, kind: "high-entropy" });
    }
  }
}

// Where an unquoted value ends: whitespace, a quote, or a shell command separator.
// Brackets and commas do not end it, so `PASSWORD=abc]def` masks the whole word;
// the looser assignment forms stop at the first comma or bracket instead (see classify).
const UNQUOTED_STOP = new Set([..." \t\r\n\f\v\"'`;&|"]);

const SYNTAX_STOP = new Set([...",)}]>"]);

interface Ends {
  /** For each index, where an unquoted value starting there ends. */
  word: Int32Array;
  /** For each index, the next comma or closing bracket (or the text length). */
  syntax: Int32Array;
}

/** Precomputes both end tables in one backward pass, so reading any value is O(1). */
function valueEnds(input: string): Ends {
  const n = input.length;
  const word = new Int32Array(n + 1);
  const syntax = new Int32Array(n + 1);
  word[n] = n;
  syntax[n] = n;
  for (let i = n - 1; i >= 0; i--) {
    const ch = input.charAt(i);
    word[i] = UNQUOTED_STOP.has(ch) || /\s/.test(ch) ? i : (word[i + 1] ?? i);
    syntax[i] = SYNTAX_STOP.has(ch) ? i : (syntax[i + 1] ?? i);
  }
  return { word, syntax };
}

interface Value {
  start: number;
  end: number;
  /** Where the value ends in loose (code-like) forms: also at a comma or closing bracket. */
  looseEnd: number;
  quoted: boolean;
}

/** Reads the value at `at`: a quoted string up to its closing quote or line end, or an unquoted run. */
function readValue(input: string, at: number, ends: Ends): Value {
  const quote = input.charAt(at);
  if (quote === '"' || quote === "'") {
    let i = at + 1;
    while (i < input.length) {
      const ch = input.charAt(i);
      if (ch === quote || ch === "\n" || ch === "\r") break;
      i += ch === "\\" ? 2 : 1;
    }
    const end = Math.min(i, input.length);
    return { start: at + 1, end, looseEnd: end, quoted: true };
  }
  let end = ends.word[at] ?? at;
  // A reference such as `$(cat ~/.pw)` or `${{ secrets.X }}` may contain spaces;
  // the value runs through it and on to the end of the word that follows.
  const ref = referenceLength(input, at);
  if (ref > 0 && at + ref > end) end = ends.word[at + ref] ?? at + ref;
  return { start: at, end, looseEnd: Math.min(end, ends.syntax[at] ?? end), quoted: false };
}

function findAssignments(input: string, ends: Ends, out: Candidate[]): void {
  for (const match of input.matchAll(ASSIGNMENT)) {
    const name = match[2] ?? "";
    const tight = match[3] === "" && match[4] === "=";
    // `NAME= next` assigns an empty value in a shell; the next word is not it.
    if (tight && match[5] !== "") continue;
    const value = readValue(input, match.index + match[0].length, ends);
    // `NAME=value` with no spaces, as in shell and .env files and query strings.
    classify(input, name, value, value.quoted || tight, out);
  }
}

function findFlags(input: string, ends: Ends, out: Candidate[]): void {
  for (const match of input.matchAll(FLAG)) {
    const name = match[1] ?? "";
    if (!isSensitiveName(name)) continue;
    const at = match.index + match[0].length;
    if (input.charAt(at) === "-") continue;
    const value = readValue(input, at, ends);
    classify(input, name, value, value.quoted || match[2] === "=", out);
  }
}

/**
 * Masks the password in `-u user:password` style flags. Not masked: no colon, an
 * empty password or a reference (`$API_TOKEN`, `$(id -g)`), and a numeric
 * `uid:gid` pair (`docker run -u 1000:1000`). Other `-u` uses with a colon, such
 * as `rsync -u host:/srv`, are masked: hiding a path costs less than a password.
 */
function findUserFlags(input: string, ends: Ends, out: Candidate[]): void {
  for (const match of input.matchAll(USER_FLAG)) {
    const at = match.index + match[0].length;
    if (input.charAt(at) === "-") continue;
    const value = readValue(input, at, ends);
    // Skip a leading reference such as `$(id -u)` or `$API_USER` before looking
    // for the colon, so a colon inside it is not taken as the separator.
    const from = value.start + referenceLength(input, value.start);
    const stop = Math.min(value.end, from + MAX_USER);
    let colon = -1;
    for (let i = from; i < stop; i++) {
      if (input.charCodeAt(i) === 0x3a /* : */) {
        colon = i;
        break;
      }
    }
    if (colon < 0) continue;
    // Quoted, the password runs to the closing quote (it may hold spaces); unquoted,
    // it is read as a value of its own so a reference after the colon is whole.
    const password = value.quoted
      ? { start: colon + 1, end: value.end }
      : readValue(input, colon + 1, ends);
    const { start, end } = password;
    if (isPlaceholder(input, start, end)) continue;
    if (isNumeric(input, value.start, colon) && isNumeric(input, start, end)) continue;
    out.push({ start, end, kind: "basic-auth" });
  }
}

/** True when `input.slice(start, end)` is 1 to 10 ASCII digits. */
function isNumeric(input: string, start: number, end: number): boolean {
  if (end <= start || end - start > 10) return false;
  for (let i = start; i < end; i++) {
    const c = input.charCodeAt(i);
    if (c < 0x30 || c > 0x39) return false;
  }
  return true;
}

/**
 * Decides whether an assigned value is masked. A sensitive name masks any real
 * value when the assignment form is unambiguous (quoted, or `NAME=value`); in looser
 * forms (`name: value`, `name = value`, `--name value`) the value must also look like
 * a credential, so prose and code such as `token = getToken()` stay readable. Any
 * name masks a high-entropy value.
 */
function classify(
  input: string,
  name: string,
  value: Value,
  strict: boolean,
  out: Candidate[],
): void {
  const { start, end } = value;
  if (isPlaceholder(input, start, end)) return;
  const sensitive = isSensitiveName(name);
  if (sensitive && strict) {
    out.push({ start, end, kind: "sensitive-value" });
    return;
  }
  // Loose forms are often code (`{password: hunter2,port:5432}`), so the value ends
  // at the first comma or closing bracket, which is syntax rather than part of it.
  classifyLoose(input, start, value.looseEnd, sensitive, out);
}

function classifyLoose(
  input: string,
  start: number,
  end: number,
  sensitive: boolean,
  out: Candidate[],
): void {
  // Both looser checks reject anything longer, so skip the copy.
  if (end - start > 256) return;
  const text = input.slice(start, end);
  if (sensitive && (looksLikeCredential(text) || isHighEntropyToken(text))) {
    out.push({ start, end, kind: "sensitive-value" });
  } else if (isHighEntropyToken(text)) {
    out.push({ start, end, kind: "high-entropy" });
  }
}

/** Sorts and unions overlapping candidates; the union keeps the highest-priority kind. */
function merge(candidates: Candidate[]): Candidate[] {
  candidates.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Candidate[] = [];
  for (const c of candidates) {
    const last = merged.at(-1);
    if (last !== undefined && c.start < last.end) {
      last.end = Math.max(last.end, c.end);
      if (PRIORITY[c.kind] < PRIORITY[last.kind]) last.kind = c.kind;
    } else {
      merged.push({ ...c });
    }
  }
  return merged;
}

function applyMasks(input: string, masks: Candidate[]): RedactedText {
  let text = "";
  let at = 0;
  const spans: MaskSpan[] = [];
  for (const { start, end, kind } of masks) {
    text += input.slice(at, start);
    const marker = maskMarker(kind);
    spans.push({
      kind,
      start,
      end,
      maskedStart: text.length,
      maskedEnd: text.length + marker.length,
    });
    text += marker;
    at = end;
  }
  return { text: text + input.slice(at), spans };
}
