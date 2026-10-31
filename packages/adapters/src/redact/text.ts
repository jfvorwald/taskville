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
// run of token characters is tried from its first character only. A known prefix may
// follow `_` (`mcp__server__ghp_...`, `MY_TOKEN_sk-...`, M2.14): those patterns either
// stop at `_` or consume the whole run greedily, so a start after `_` still scans each
// character a bounded number of times. The JWT pattern keeps `_` in its lookbehind,
// because its body must reach a `.`, and a run of `_eyJ` with no dot would be rescanned
// from every start.
const TOKEN_PATTERNS: ReadonlyArray<{
  kind: MaskKind;
  pattern: RegExp;
  group?: number;
  /** Extra evidence the match must show, for patterns that also match prose. */
  accept?: (match: RegExpMatchArray) => boolean;
}> = [
  { kind: "anthropic-key", pattern: /(?<![A-Za-z0-9-])sk-ant-[A-Za-z0-9_-]{20,}/dg },
  {
    // The digit is checked after the match rather than with a lookahead: the greedy body
    // consumes the whole run, so a digit-free run is scanned once, not once per `_sk-` in it.
    kind: "openai-key",
    pattern: /(?<![A-Za-z0-9-])sk-[A-Za-z0-9_-]{20,}/dg,
    accept: (match) => /[0-9]/.test(match[0].slice(3)),
  },
  { kind: "github-token", pattern: /(?<![A-Za-z0-9])gh[pousr]_[A-Za-z0-9]{36,}/dg },
  { kind: "github-token", pattern: /(?<![A-Za-z0-9])github_pat_[A-Za-z0-9_]{22,}/dg },
  {
    kind: "aws-access-key",
    pattern: /(?<![A-Za-z0-9+/])(?:AKIA|ASIA|ABIA|ACCA)[A-Z0-9]{16}(?![A-Za-z0-9])/dg,
  },
  { kind: "slack-token", pattern: /(?<![A-Za-z0-9-])(?:xox[abposre]|xapp)-[A-Za-z0-9-]{10,}/dg },
  { kind: "stripe-key", pattern: /(?<![A-Za-z0-9])(?:sk|rk)_(?:live|test)_[A-Za-z0-9]{16,}/dg },
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

// `Authorization: <scheme> name=value, name="value", ...`: Digest, AWS SigV4, OAuth
// 1.0 and other parameterized schemes, whose credential sits in a later parameter.
// The rest of the line is masked rather than parsed, so no quoting, escaping, or
// spacing inside the list can end the mask early. The character after `=` must
// start a value, so a token68 credential with `=` padding (`Basic dXNlcjpw==`) is
// not taken for a parameter list. An empty or space-led quoted value (`a="",` or
// `a=" x",`) counts when a comma follows it, since a closing shell quote does not.
const AUTH_PARAMS =
  /(?<![A-Za-z0-9_])authorization["']?[ \t]*[:=][ \t]*["']?[A-Za-z][A-Za-z0-9._-]{0,31}[ \t]+(?=[A-Za-z0-9_.-]{1,64}[ \t]*=[ \t]*(?:\\?"(?![\s"]|$)|\\?"(?:[^"\\\r\n]|\\.){0,256}?\\?"[ \t]*,|[A-Za-z0-9_.~+/-]))/gi;

// curl's `-u user:password` (also attached, `-uuser:password`), `--user user:password`,
// `--user=user:password`, and the proxy forms `-U` and `--proxy-user`.
const USER_FLAG = /(?<![A-Za-z0-9_-])(?:-[uU][ \t]*|--(?:proxy-)?user(?:=|[ \t]+))/g;

// The colon that ends the user name is looked for only this far, so a long run
// after a flag costs a bounded scan per match.
const MAX_USER = 128;

// Commands whose short `-p` flag carries a password. Everywhere else `-p` is a port or
// publish flag (`ssh -p 2222`, `docker run -p 8080:80`, `psql -p 5432`), so the rule is
// tied to these commands and nothing else. Group 1 is `mysql` or `mysqldump`, 2 is
// `sshpass`, 3 is `docker` or `podman`, which count only when the subcommand is `login`
// (see loginStart). A path in front (`/usr/bin/mysql`) is fine.
const PASSWORD_COMMAND =
  /(?<![A-Za-z0-9_.-])(?:(mysqldump|mysql)|(sshpass)|(docker|podman))(?![A-Za-z0-9_-]|\.[A-Za-z0-9])/g;

// Words read after one of those commands, so a long line costs a bounded scan.
const MAX_COMMAND_WORDS = 256;

// A `{"name": "DB_PASSWORD", "value": "..."}` pair (Kubernetes env, the GitHub API, AWS
// tags, `docker inspect`) written as text, in either property order and across lines.
// PAIR_NAME finds the name (group 3); the value is read by hand.
const PAIR_NAME = /(["'])(?:name|key)\1\s*:\s*(["'])([A-Za-z_][A-Za-z0-9_.-]{0,99})\2/gi;
const VALUE_KEY_AFTER = /\s*,\s*(["'])value\1\s*:\s*/iy;
const VALUE_KEY = /(["'])value\1\s*:\s*/gi;

// Work allowed for reading values that come before their name, in characters scanned per
// call. A `"value":` only counts once the name that follows is known to be sensitive, but
// each one in front of it is tried; past this budget the text up to the name is masked
// instead, so a crafted run costs bounded time and never leaves a value readable.
const PAIR_SCAN_BUDGET = 500_000;

/** Masks secret-looking values in a string. Deterministic and idempotent. */
export function redactText(input: string): RedactedText {
  const candidates: Candidate[] = [];
  findPrivateKeys(input, candidates);
  findTokens(input, candidates);
  const ends = valueEnds(input);
  findAssignments(input, ends, candidates);
  findFlags(input, ends, candidates);
  findPasswordFlags(input, candidates);
  findNameValuePairs(input, ends, candidates);
  findAuthParams(input, candidates);
  findUserFlags(input, candidates);
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
 * Masks the password in the short `-p` flag of `mysql`, `mysqldump`, `sshpass`, and
 * `docker|podman login`, in the rest of that command (up to a newline, `;`, `&`, or `|`).
 * `mysql` and `mysqldump` read the password only when attached (`-pSECRET`; a bare `-p`
 * prompts, and the next word is the database). `sshpass` and `login` also take `-p SECRET`.
 * `sshpass` options end at the first word that is not one, so `sshpass -p x ssh -p 2222 host`
 * masks `x` and leaves the port. Not masked: no value, or a value that is one complete
 * reference (`-p"$DB_PASS"`, `-p $TOKEN`).
 */
function findPasswordFlags(input: string, out: Candidate[]): void {
  let scannedUntil = 0;
  for (const match of input.matchAll(PASSWORD_COMMAND)) {
    if (match.index < scannedUntil) continue;
    const spaced = match[1] === undefined; // sshpass and login take `-p SECRET` too
    const sshpass = match[2] !== undefined;
    let at = match.index + match[0].length;
    if (match[3] !== undefined) {
      at = loginStart(input, at);
      if (at < 0) continue;
    }
    for (let words = 0; words < MAX_COMMAND_WORDS; words++) {
      at = skipBlanks(input, at);
      const end = shellWordEnd(input, at);
      if (end === at) break; // newline, `;`, `&`, `|`, a backtick, or the end of the text
      scannedUntil = end;
      if (input.charAt(at) !== "-") {
        if (sshpass) break; // the command sshpass runs: its own flags are not ours
        at = end;
        continue;
      }
      const flag = input.charAt(at + 1);
      if (flag === "p" && end - at > 2) {
        pushPassword(input, at + 2, end, out);
      } else if (flag === "p" && end - at === 2 && spaced) {
        const start = skipBlanks(input, end);
        const valueEnd = shellWordEnd(input, start);
        pushPassword(input, start, valueEnd, out);
        scannedUntil = Math.max(scannedUntil, valueEnd);
        at = Math.max(end, valueEnd);
        continue;
      } else if (sshpass && end - at === 2 && (flag === "f" || flag === "d" || flag === "P")) {
        // sshpass -f FILE, -d FD, -P PROMPT: the next word belongs to the option.
        const start = skipBlanks(input, end);
        at = Math.max(end, shellWordEnd(input, start));
        scannedUntil = Math.max(scannedUntil, at);
        continue;
      }
      at = end;
    }
  }
}

/**
 * Where the words after `docker` or `podman` continue after `login`, or -1 if the subcommand
 * is something else. Global options come first (`docker --config "/tmp/my dir" login`): a
 * word that starts with `-` is an option, and a word right after one is its value, read
 * as a shell word so quotes and escaped spaces stay inside it.
 */
function loginStart(input: string, from: number): number {
  let at = from;
  let afterOption = false;
  for (let words = 0; words < 9; words++) {
    at = skipBlanks(input, at);
    const end = shellWordEnd(input, at);
    if (end === at) return -1;
    if (input.charAt(at) === "-") {
      afterOption = true;
    } else if (end - at === 5 && input.startsWith("login", at)) {
      return end;
    } else if (afterOption) {
      afterOption = false;
    } else {
      return -1;
    }
    at = end;
  }
  return -1;
}

function skipBlanks(input: string, at: number): number {
  let i = at;
  while (input.charAt(i) === " " || input.charAt(i) === "\t") i++;
  return i;
}

/** Marks a shell word as a password, dropping quotes that wrap all of it. */
function pushPassword(input: string, from: number, to: number, out: Candidate[]): void {
  let start = from;
  let end = to;
  const first = input.charAt(start);
  if (
    (first === '"' || first === "'") &&
    end - start >= 2 &&
    quotedEnd(input, start + 1, first) === end - 1
  ) {
    start += 1;
    end -= 1;
  }
  if (!isPlaceholder(input, start, end)) out.push({ start, end, kind: "sensitive-value" });
}

/**
 * End of an unquoted pair value: at a comma or bracket, except that a marker or reference
 * (a sealed number leaves `"value":[REDACTED:sensitive-value]}`) ends where it ends, and
 * anything glued to it (`[REDACTED:x]hunter2`) stays part of the value.
 */
function pairValueEnd(input: string, value: Value): number {
  const ref = referenceLength(input, value.start);
  if (ref === 0) return value.looseEnd;
  const after = value.start + ref;
  return after >= value.end || SYNTAX_STOP.has(input.charAt(after)) ? after : value.end;
}

/**
 * End of the `{...}` or `[...]` that opens at `at`, and whether it closed: quote-aware,
 * counting both bracket kinds. One that never closes runs to the end of `limit`.
 */
function balancedEnd(input: string, at: number, limit: number): { end: number; closed: boolean } {
  const stop = Math.min(input.length, limit);
  let depth = 0;
  let quote = "";
  for (let i = at; i < stop; i++) {
    const ch = input.charAt(i);
    if (quote !== "") {
      if (ch === "\\") i += 1;
      else if (ch === quote) quote = "";
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === "{" || ch === "[") {
      depth += 1;
    } else if ((ch === "}" || ch === "]") && --depth === 0) {
      return { end: i + 1, closed: true };
    }
  }
  return { end: stop, closed: false };
}

interface PairValue {
  /** The span to mask. */
  start: number;
  end: number;
  /** Where the value token ends, quotes included. */
  next: number;
  /** False for a string or object that has no closing quote or bracket before `limit`. */
  closed: boolean;
}

/**
 * Reads the value of a pair at `at`: a string, a number, or a whole object or array,
 * looking no further than `limit`.
 */
function readPairValue(input: string, ends: Ends, at: number, limit: number): PairValue | null {
  const first = input.charAt(at);
  // `[REDACTED:...]` opens with a bracket too, but it is a marker, read as a plain value.
  if ((first === "{" || first === "[") && referenceLength(input, at) === 0) {
    const { end, closed } = balancedEnd(input, at, limit);
    return { start: at, end, next: end, closed };
  }
  const value = readValue(input, at, ends);
  if (value.quoted) {
    const closed = input.charAt(value.end) === first && value.end < limit;
    return { start: value.start, end: value.end, next: closed ? value.end + 1 : value.end, closed };
  }
  const end = pairValueEnd(input, value);
  // JSON `null` carries nothing, and redactJson leaves it.
  if (input.slice(value.start, end) === "null") return null;
  return { start: value.start, end, next: end, closed: end <= limit };
}

/**
 * Masks the value of a text `{"name": "DB_PASSWORD", "value": ...}` pair, in either
 * property order. The two properties must sit next to each other, as `JSON.stringify` and
 * Kubernetes manifests write them; a property in between ends the match.
 */
function findNameValuePairs(input: string, ends: Ends, out: Candidate[]): void {
  // `"value"` after a sensitive name. A value that never closes runs to the end of the text,
  // so each scan is paid once: what it covers is masked, and the matches inside are skipped.
  let maskedUntil = 0;
  const anchors: Array<{ comma: number }> = [];
  for (const match of input.matchAll(PAIR_NAME)) {
    if (!isSensitiveName(match[3] ?? "")) continue;
    const nameEnd = match.index + match[0].length;
    let comma = match.index;
    while (comma > 0 && /\s/.test(input.charAt(comma - 1))) comma--;
    if (input.charAt(comma - 1) === ",") anchors.push({ comma: comma - 1 });
    if (match.index < maskedUntil) continue;
    VALUE_KEY_AFTER.lastIndex = nameEnd;
    if (VALUE_KEY_AFTER.exec(input) === null) continue;
    const value = readPairValue(input, ends, VALUE_KEY_AFTER.lastIndex, input.length);
    if (value === null) continue;
    maskedUntil = value.next;
    if (!isPlaceholder(input, value.start, value.end)) {
      out.push({ start: value.start, end: value.end, kind: "sensitive-value" });
    }
  }
  if (anchors.length === 0) return;
  // `"value"` before a sensitive name: the value must close exactly where the comma in front
  // of the name sits, so a name nested inside the value does not end it early. Candidates are
  // tried from the earliest, so the outer value wins over any `"value"` inside it.
  const starts = [...input.matchAll(VALUE_KEY)].map((m) => m.index + m[0].length);
  let budget = PAIR_SCAN_BUDGET;
  for (const { comma } of anchors) {
    for (let k = 0; k < starts.length && (starts[k] ?? 0) < comma; k++) {
      const at = starts[k] ?? 0;
      if (budget <= 0) {
        // Out of budget: mask from the first `"value"` in the text to this name. An outer value
        // that holds an earlier name starts before it, so nothing later is a safe start.
        out.push({ start: starts[0] ?? at, end: comma, kind: "sensitive-value" });
        break;
      }
      const value = readPairValue(input, ends, at, comma);
      budget -= (value?.next ?? comma) - at + 1;
      if (value === null || !value.closed || !/^\s*$/.test(input.slice(value.next, comma)))
        continue;
      if (!isPlaceholder(input, value.start, value.end)) {
        out.push({ start: value.start, end: value.end, kind: "sensitive-value" });
      }
      break;
    }
  }
}

/**
 * Masks the password in `-u user:password` style flags: everything after the first
 * colon of the shell word, which joins quoted and unquoted segments
 * (`"$API_USER"suffix:pass`). Not masked: no colon, an empty password, or a password
 * that is one complete reference (`$API_TOKEN`, `$(id -g)`). Other `-u` uses with a
 * colon, such as `rsync -u host:/srv` or `docker run -u 1000:1000`, are masked too:
 * hiding a path or group ID costs less than leaking a password.
 */
function findUserFlags(input: string, out: Candidate[]): void {
  // A flag inside a password already masked is hidden anyway; skipping it keeps
  // `--user=a:--user=a:...` linear. A flag inside a password left readable (one
  // complete reference, at most a few hundred characters) is still read, and so is
  // one inside a user that has no colon, so `-u $(curl -u admin:pass ...)` and
  // `-u x:$(curl -u admin:pass ...)` mask the inner password.
  let maskedUntil = 0;
  for (const match of input.matchAll(USER_FLAG)) {
    if (match.index < maskedUntil) continue;
    const at = match.index + match[0].length;
    // `-u -k` has no value; `$(id -u)` ends a substitution with a bare flag.
    if (input.charAt(at) === "-" || input.charAt(at) === ")") continue;
    const separator = userSeparator(input, at);
    if (separator === null) continue;
    const { colon, quote } = separator;
    let start = colon + 1;
    let end: number;
    if (quote === "") {
      end = shellWordEnd(input, start);
      // `user:"pass"`: drop quotes that wrap the whole password.
      const first = input.charAt(start);
      if (
        (first === '"' || first === "'") &&
        end - start >= 2 &&
        quotedEnd(input, start + 1, first) === end - 1
      ) {
        start += 1;
        end -= 1;
      }
    } else {
      // `"user:pass"`: the password runs to the closing quote and on through any
      // segments joined to it; a closing quote that ends the word is dropped.
      const close = quotedEnd(input, start, quote);
      if (input.charAt(close) !== quote) {
        end = close;
      } else {
        end = shellWordEnd(input, close + 1);
        if (end === close + 1) end = close;
      }
    }
    if (isPlaceholder(input, start, end)) continue;
    out.push({ start, end, kind: "basic-auth" });
    maskedUntil = end;
  }
}

/**
 * The colon ending the user name in the shell word at `at`, and the quote open
 * around it ("" if none). Looks at most MAX_USER characters ahead, skips complete
 * references (`$(id -u)`, `${USER:-x}`) outside quotes, and gives null if the word
 * ends first.
 */
function userSeparator(input: string, at: number): { colon: number; quote: string } | null {
  const stop = Math.min(input.length, at + MAX_USER);
  let quote = "";
  let i = at;
  while (i < stop) {
    const ch = input.charAt(i);
    if (quote !== "") {
      if (ch === "\n" || ch === "\r") return null;
      if (ch === ":") return { colon: i, quote };
      const escaped = ch === "\\" && quote === '"';
      if (ch === quote) quote = "";
      i += escaped ? 2 : 1;
      continue;
    }
    if (ch === ":") return { colon: i, quote };
    if (ch === '"' || ch === "'") {
      quote = ch;
      i += 1;
      continue;
    }
    const ref = referenceLength(input, i);
    if (ref > 0) {
      i += ref;
      continue;
    }
    if (UNQUOTED_STOP.has(ch) || /\s/.test(ch)) return null;
    i += 1;
  }
  return null;
}

/**
 * End of the shell word at `at`: quoted and unquoted segments joined, complete
 * references (`$(id -u)`) taken whole, backslash escapes honored. Ends at whitespace or a
 * command separator outside quotes; an unterminated quote ends it at the line end.
 */
function shellWordEnd(input: string, at: number): number {
  let i = at;
  while (i < input.length) {
    const ch = input.charAt(i);
    if (ch === '"' || ch === "'") {
      const close = quotedEnd(input, i + 1, ch);
      if (input.charAt(close) !== ch) return close;
      i = close + 1;
      continue;
    }
    const ref = referenceLength(input, i);
    if (ref > 0) {
      i += ref;
      continue;
    }
    // A backslash outside quotes escapes the next character: `pa\ ss` is one word, and a
    // backslash before a line break continues the word on the next line.
    if (ch === "\\") {
      i += 2;
      continue;
    }
    if (UNQUOTED_STOP.has(ch) || /\s/.test(ch)) return i;
    i += 1;
  }
  return Math.min(i, input.length);
}

/**
 * Index of the `quote` that closes a quoted segment whose text starts at `from`,
 * or of the line end (or text end) if none. Backslash escapes inside double quotes.
 */
function quotedEnd(input: string, from: number, quote: string): number {
  let j = from;
  while (j < input.length) {
    const ch = input.charAt(j);
    if (ch === quote || ch === "\n" || ch === "\r") return j;
    j += ch === "\\" && quote === '"' ? 2 : 1;
  }
  return input.length;
}

/** Masks from the first parameter of a parameterized Authorization scheme to the line end. */
function findAuthParams(input: string, out: Candidate[]): void {
  let coveredUntil = 0;
  for (const match of input.matchAll(AUTH_PARAMS)) {
    const start = match.index + match[0].length;
    if (start < coveredUntil) continue;
    let end = start;
    while (end < input.length && input.charAt(end) !== "\n" && input.charAt(end) !== "\r") end++;
    coveredUntil = end;
    if (end > start) out.push({ start, end, kind: "bearer-token" });
  }
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
