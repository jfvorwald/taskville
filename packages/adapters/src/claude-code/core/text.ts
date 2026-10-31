import { codePointLength, INPUT_REASON_MAX_CHARS } from "@taskville/protocol";
import { redactText } from "../../redact/index.ts";

/** Max code points of a one-line summary on a ToolCall. */
export const SUMMARY_MAX = 280;
/** Max code points of a name, role, tool name, or outcome. */
export const NAME_MAX = 200;
/** Max code points of a path. */
export const PATH_MAX = 4096;

/**
 * Prepares agent-supplied text for an event field: lone surrogates replaced (L-31), secrets
 * masked, then cut to `max` code points after masking (L-32). Returns undefined for a non-string
 * or for text that ends up empty.
 */
export function cleanText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const masked = redactText(value.toWellFormed()).text;
  const cut = cutCodePoints(masked, max);
  return cut === "" ? undefined : cut;
}

/**
 * Prepares a `reason`. The engine masks a reason at ingest and stores `masked: true` when it did
 * (FR-017), so the reason is passed on unmasked: masking it here would make the engine record
 * `masked: false` for masked text. A reason over the 4,000-character input limit is cut there,
 * before any secret the cut touches, and the cut text is checked to still show every secret it
 * keeps: some secrets are recognized only from text after them (the `@` after a URL password,
 * job 5100). If one would no longer be recognized, the reason is cut before the first secret.
 */
export function cleanReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.toWellFormed();
  if (text === "") return undefined;
  if (codePointLength(text) <= INPUT_REASON_MAX_CHARS) return text;
  const spans = redactText(text).spans;
  let cut = cutCodePoints(text, INPUT_REASON_MAX_CHARS).length;
  // Spans are sorted and disjoint, so one pass moves the cut out of all of them.
  for (const span of spans) {
    if (span.start < cut && cut <= span.end) cut = span.start;
  }
  if (!keepsEverySecretVisible(text.slice(0, cut), spans, cut)) {
    // Text before the first secret holds none, whatever follows it.
    cut = spans.find((span) => span.start < cut)?.start ?? cut;
  }
  const out = text.slice(0, cut);
  return out === "" ? undefined : out;
}

/** True when the redactor still finds every secret of `spans` that lies wholly in `kept`. */
function keepsEverySecretVisible(
  kept: string,
  spans: readonly { start: number; end: number }[],
  cut: number,
): boolean {
  const inKept = spans.filter((span) => span.end <= cut);
  if (inKept.length === 0) return true;
  const again = redactText(kept).spans;
  return inKept.every((span) => again.some((a) => a.start <= span.start && a.end >= span.end));
}

/** The first line of already cleaned text. */
export function firstLine(text: string | undefined): string | undefined {
  if (text === undefined) return undefined;
  const line = text.split(/\r?\n/, 1)[0] ?? "";
  return line === "" ? undefined : line;
}

function cutCodePoints(text: string, max: number): string {
  // Code units never undercount code points, so short text needs no walk.
  if (text.length <= max) return text;
  let out = "";
  let count = 0;
  for (const char of text) {
    if (count === max) break;
    out += char;
    count += 1;
  }
  return out;
}

/** The last segment of a POSIX or Windows path, ignoring trailing separators. */
export function baseName(path: string): string {
  let end = path.length;
  while (end > 0 && (path[end - 1] === "/" || path[end - 1] === "\\")) end -= 1;
  const trimmed = path.slice(0, end);
  const at = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
  return trimmed.slice(at + 1);
}
