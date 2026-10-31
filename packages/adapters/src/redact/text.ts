import {
  isHighEntropyToken,
  isPlaceholder,
  isSensitiveName,
  looksLikeCredential,
  type MaskKind,
  maskMarker,
  PRIORITY,
  startsWithMarker,
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
const TOKEN_PATTERNS: ReadonlyArray<{ kind: MaskKind; pattern: RegExp; group?: number }> = [
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
    pattern: /(?<![A-Za-z0-9])(?:[Bb]earer|BEARER)[ \t]+([A-Za-z0-9._~+/-]{16,}=*)/dg,
    group: 1,
  },
  {
    kind: "basic-auth",
    pattern: /(?<![A-Za-z0-9])[Aa]uthorization:[ \t]*[Bb]asic[ \t]+([A-Za-z0-9+/]{8,}={0,2})/dg,
    group: 1,
  },
];

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

/** Masks secret-looking values in a string. Deterministic and idempotent. */
export function redactText(input: string): RedactedText {
  const candidates: Candidate[] = [];
  findPrivateKeys(input, candidates);
  findTokens(input, candidates);
  const valueEnds = unquotedValueEnds(input);
  findAssignments(input, valueEnds, candidates);
  findFlags(input, valueEnds, candidates);
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
  for (const { kind, pattern, group } of TOKEN_PATTERNS) {
    for (const match of input.matchAll(pattern)) {
      const [start, end] = match.indices?.[group ?? 0] ?? [match.index, match.index];
      if (end <= start || startsWithMarker(input, start)) continue;
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

const UNQUOTED_STOP = new Set([..." \t\r\n\f\v\"'`;&|,)}]<>"]);

/** For each index, where an unquoted value starting there ends. One pass, O(n). */
function unquotedValueEnds(input: string): Int32Array {
  const ends = new Int32Array(input.length + 1);
  ends[input.length] = input.length;
  for (let i = input.length - 1; i >= 0; i--) {
    ends[i] =
      UNQUOTED_STOP.has(input.charAt(i)) || /\s/.test(input.charAt(i)) ? i : (ends[i + 1] ?? i);
  }
  return ends;
}

interface Value {
  start: number;
  end: number;
  quoted: boolean;
}

/** Reads the value at `at`: a quoted string up to its closing quote or line end, or an unquoted run. */
function readValue(input: string, at: number, valueEnds: Int32Array): Value {
  const quote = input.charAt(at);
  if (quote === '"' || quote === "'") {
    let i = at + 1;
    while (i < input.length) {
      const ch = input.charAt(i);
      if (ch === quote || ch === "\n" || ch === "\r") break;
      i += ch === "\\" ? 2 : 1;
    }
    return { start: at + 1, end: Math.min(i, input.length), quoted: true };
  }
  return { start: at, end: valueEnds[at] ?? at, quoted: false };
}

function findAssignments(input: string, valueEnds: Int32Array, out: Candidate[]): void {
  for (const match of input.matchAll(ASSIGNMENT)) {
    const name = match[2] ?? "";
    const tight = match[3] === "" && match[4] === "=";
    // `NAME= next` assigns an empty value in a shell; the next word is not it.
    if (tight && match[5] !== "") continue;
    const value = readValue(input, match.index + match[0].length, valueEnds);
    // `NAME=value` with no spaces, as in shell and .env files and query strings.
    classify(input, name, value, value.quoted || tight, out);
  }
}

function findFlags(input: string, valueEnds: Int32Array, out: Candidate[]): void {
  for (const match of input.matchAll(FLAG)) {
    const name = match[1] ?? "";
    if (!isSensitiveName(name)) continue;
    const at = match.index + match[0].length;
    if (input.charAt(at) === "-") continue;
    const value = readValue(input, at, valueEnds);
    classify(input, name, value, value.quoted || match[2] === "=", out);
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
