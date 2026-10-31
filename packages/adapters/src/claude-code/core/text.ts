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
 * or earlier where the cut would fall inside something the redactor masks, so no secret is ever
 * left half visible for the engine to miss.
 */
export function cleanReason(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const text = value.toWellFormed();
  if (text === "") return undefined;
  if (codePointLength(text) <= INPUT_REASON_MAX_CHARS) return text;
  let cut = cutCodePoints(text, INPUT_REASON_MAX_CHARS).length;
  for (const span of redactText(text).spans) {
    if (span.start < cut && cut < span.end) cut = span.start;
  }
  const out = text.slice(0, cut);
  return out === "" ? undefined : out;
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
