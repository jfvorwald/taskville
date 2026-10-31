import { redactText } from "../../redact/index.ts";
import { isHookId } from "../core/index.ts";

// Reading untrusted hook JSON (L-18, L-29): only own properties, never a prototype; strings are
// bounded before any work; IDs must be plain tokens the redaction rules would leave alone, since
// ID fields are stored unmasked (L-17, L-40); free text is masked here and re-cut after masking
// (L-31, L-32), even though the engine masks again on ingest.

export type Json = Record<string, unknown>;

export const isRecord = (value: unknown): value is Json =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** `obj[key]` when `obj` has it as an own property, else undefined. */
export function own(obj: unknown, key: string): unknown {
  return isRecord(obj) && Object.hasOwn(obj, key) ? obj[key] : undefined;
}

export const ownRecord = (obj: unknown, key: string): Json | undefined => {
  const value = own(obj, key);
  return isRecord(value) ? value : undefined;
};

export const ownString = (obj: unknown, key: string): string | undefined => {
  const value = own(obj, key);
  return typeof value === "string" ? value : undefined;
};

/**
 * `value` if the core mapper would accept it as an ID (`isHookId`: a plain bounded token the
 * redaction rules leave alone, since ID fields are stored unmasked), else undefined.
 */
export const idToken = (value: unknown, max: number): string | undefined =>
  isHookId(value, max) ? value : undefined;

/** Work bound for free text: longer input is cut before masking. Far above any field cap. */
const SCAN_MAX = 8192;
// C0 and C1 controls and DEL; tab and line feed stay so multi-line summaries keep their shape.
// biome-ignore lint/suspicious/noControlCharactersInRegex: stripping them is the point
const CONTROLS = /[\u0000-\u0008\u000B-\u001F\u007F-\u009F]/g;

/** The first `max` code points of `text`, never splitting a surrogate pair. */
function cut(text: string, max: number): string {
  let out = "";
  let n = 0;
  for (const ch of text) {
    if (n === max) break;
    out += ch;
    n += 1;
  }
  return out;
}

/**
 * Agent-supplied text made safe to carry: well-formed, control characters removed, secrets
 * masked, then cut to `max` code points. Masking runs before the final cut so a cut can never
 * leave the unmasked head of a secret. Blank results are undefined.
 */
export function safeText(value: unknown, max: number): string | undefined {
  if (typeof value !== "string") return undefined;
  const scanned = value.slice(0, SCAN_MAX).toWellFormed().replace(CONTROLS, "");
  const text = cut(redactText(scanned).text, max).trim();
  return text === "" ? undefined : text;
}
